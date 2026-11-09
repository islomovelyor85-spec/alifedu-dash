// Call-recording analysis: Bitrix telephony recordings → Gemini (free tier) → call_review.
// Two steps: Flash writes the dialogue once from the audio; a stronger model then scores the saved text.
// Reads Bitrix only (voximplant.statistic.get, disk.file.get); never changes portal settings.
//   POST /call-analyze            cron: analyse the newest queued calls (queue is filled by sync-calls)
//   POST /call-analyze?pains=1    backfill: client pains for calls analysed before `pains` existed (text only, no audio)
// Scoring follows RUBRIC (100 points); the model returns points per criterion with evidence, totals are computed here.
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { Any, authorized, daysAgo, json, sb, sleep, upsert } from "../_shared/sync.ts";
import { bx } from "../_shared/bitrix.ts";

const LIMIT = 8, PARALLEL = 2, BUDGET_MS = 125_000;
// Free-tier quota is per model, so each list falls through to the next model on a 429 (checked with gemini-check).
const MODELS = [Deno.env.get("GEMINI_AUDIO_MODEL") ?? "gemini-3.6-flash", "gemini-3-flash-preview", "gemini-flash-lite-latest"];
// Scoring is text only and uses the newest Flash while its quota lasts; Pro has no free quota on this key.
const SCORE_MODELS = [Deno.env.get("GEMINI_SCORE_MODEL") ?? "gemini-3.8-flash", "gemini-3.7-flash", ...MODELS];

// Built from the company sales script (Miro "Sotuv ssenariysi"); keep in sync with RUBRIC in platform/audit.html.
const RUBRIC: [string, string, [string, number, string][]][] = [
  ["rapport", "Munosabat o'rnatish", [
    ["r_intro", 4, "Salomlashdi, Robbit akademiyasidan ekanini va o'z ismini aytdi"],
    ["r_name", 3, "Mijozni ismi bilan murojaat qildi (ismini so'radi yoki tasdiqladi)"],
    ["r_reason", 3, "Qo'ng'iroq sababini aytdi (qiziqish bildirgansiz / qanday yordam bera olaman)"],
  ]],
  ["filter", "Filtr", [
    ["f_who", 3, "Kim uchun (farzand) ekanini aniqladi"],
    ["f_age", 3, "Farzand yoshini so'radi"],
    ["f_region", 2, "Viloyat/filialni aniqladi"],
    ["f_price", 2, "Narx so'ralganda darhol aytmay, avval savollarga o'tdi"],
  ]],
  ["spin", "Ehtiyoj (SPIN)", [
    ["s_situation", 5, "S — farzand hozir nima bilan band, qo'shimcha kurslari, gadjet vaqti"],
    ["s_problem", 5, "P — qiziqish o'zidanmi yoki ota-ona yo'naltiryaptimi, muammoni ochdi"],
    ["s_implication", 5, "I — muammo oqibatini ko'rsatdi (vaqt besamar, qiziqish so'nadi)"],
    ["s_answer", 5, "Mijoz javobiga skriptdagi mos gap bilan munosabat bildirdi"],
  ]],
  ["fab", "Taqdimot (FAB)", [
    ["p_frame", 3, "Taqdimotga ruxsat oldi (ma'qul bo'lsa ro'yxatga olaman, kelishdikmi?)"],
    ["p_feature", 4, "F — 1 yil, haftada 3 kun, 1,5 soatdan"],
    ["p_advantage", 4, "A — 3 yo'nalish bir kursda, sun'iy intellekt, STEAM"],
    ["p_benefit", 6, "B — bolaga natija: loyihalar, portfolio, startap, Demo Day, mustaqil fikrlash"],
    ["p_questions", 2, "Taqdimot ichida savollar berdi (kompyuter, qulay vaqt, musobaqa, kutilgan natija)"],
    ["p_value", 2, "Qo'shimcha qiymat: o'quv bo'limi, musobaqalar, Robbit ilovasi, gemifikatsiya"],
  ]],
  ["socratic", "Sokrat (yopish)", [
    ["c_questions", 3, "\"Qanday savollaringiz bor?\" deb so'radi"],
    ["c_agree", 4, "\"Dasturlar ma'qul keldimi?\" — mijozdan \"ha\" oldi"],
    ["c_trial", 5, "Bepul amaliy darsga taklif qildi"],
    ["c_book", 3, "Aniq vaqtga yozdi yoki ro'yxatga olishni so'radi"],
  ]],
  ["objections", "E'tirozlar", [
    ["o_isolate", 4, "E'tirozni ajratdi (\"narxdan boshqa hammasi ma'qulmi?\" / 3 holat savoli)"],
    ["o_script", 4, "Skriptdagi javobni ishlatdi (investitsiya, garantiya, vaqt, lokatsiya, maslahat)"],
    ["o_deadline", 4, "Joyni band qilib, javob muddatini belgiladi (masalan ertalab 10:00 gacha)"],
  ]],
  ["deal", "Kelishuv va Telegram", [
    ["d_telegram", 4, "Telegramdan ma'lumot va lokatsiya yuborishni kelishdi"],
    ["d_next", 4, "Keyingi qadam aniq: sana, vaqt, kim bog'lanadi"],
    ["d_discount", 4, "Chegirmani reglament bo'yicha taklif qildi: ro'yxatdagi foiz va muddat, faqat bitta, kerak bo'lsa ma'lumotnoma (chegirma gapirilmasa — tegishli emas)"],
  ]],
];
const CRITERIA = RUBRIC.flatMap(([stage, , items]) => items.map(([code, max, text]) => ({ stage, code, max, text })));

const PROMPT = `Siz Robbit akademiyasi (bolalar robototexnika/dasturlash kurslari) call-markaz sifat nazoratchisisiz.
Audio — operator va ota-ona (mijoz) qo'ng'irog'i (o'zbek/rus tilida). Faqat eshitganingizga tayaning, o'ylab topmang.

DIALOGDA ROLLARNI TO'G'RI AJRATING (eng muhim):
- "Avtojavob:" — yozib qo'yilgan ovoz (IVR): "Robbit akademiyasiga qo'ng'iroq qildingiz, operator javobini kuting", "qo'ng'irog'ingiz yozib olinishi mumkin" va h.k. Bu operator EMAS.
- "Operator:" — Robbit xodimi: o'zini "Robbit akademiyasidan" deb tanishtiradi, kurs, filial, narx, dars vaqti haqida ma'lumot beradi, savol so'raydi, yozib qo'yishni taklif qiladi.
- "Mijoz:" — ota-ona yoki bola: farzandi haqida gapiradi, kurs haqida so'raydi, rozi bo'ladi yoki e'tiroz bildiradi.
- Qo'ng'iroq yo'nalishi: {DIRECTION}. Chiquvchi qo'ng'iroqda birinchi "Allo" deb javob beruvchi odatda Mijoz; kiruvchi qo'ng'iroqda avtojavobdan keyin birinchi gapirgan odatda Operator.
- Har bir qatorni yozishdan oldin kim gapirayotganini mazmunga qarab tekshiring; bitta odamning ketma-ket gaplarini bitta qatorga birlashtiring.
Operatorni kompaniya sotuv skriptiga (pastda) qanchalik amal qilgani bo'yicha baholang: munosabat → filtr → SPIN → FAB → Sokrat yopish savollari → Telegram/kelishuv → e'tirozlar.
Avval call_type ni aniqlang: "sotuv" (yangi mijozga kurs sotish/maslahat), "eslatma" (dars, to'lov, workshop eslatmasi), "xizmat" (mavjud o'quvchi masalasi), "boshqa".
call_type "sotuv" bo'lmasa — barcha mezonlar applicable=false (bunday qo'ng'iroq menejer bahosiga kirmaydi), lekin summary va mistakes yozing.

BAHOLASH REGLAMENTI (jami 100 ball). Har bir mezon uchun 0..max ball qo'ying:
${CRITERIA.map((c) => `- ${c.code} (max ${c.max}): ${c.text}`).join("\n")}
Qoidalar: to'liq bajarilsa — max; qisman — max ning yarmi atrofida; bajarilmasa — 0.
Vaziyatga aloqasi yo'q mezon (masalan, e'tiroz bo'lmagan bo'lsa o_*) — applicable=false, ball 0.
Chegirma reglamentini buzish (ro'yxatda yo'q foiz, noto'g'ri muddat, ikkita chegirma, ma'lumotnomasiz) — d_discount=0 va mistakes ga albatta yozing, better da reglamentga mos gapni bering.
Har bir ball uchun evidence: qo'ng'iroqdan qisqa iqtibos yoki "aytilmadi".

JSON qaytaring (matnlar o'zbek tilida):
- transcript: dialog matni, har qator "Avtojavob: …", "Operator: …" yoki "Mijoz: …" (shaxsiy raqam/manzilni [yashirildi] bilan almashtiring)
- call_type: "sotuv" | "eslatma" | "xizmat" | "boshqa"
- summary: 1–2 jumla
- outcome: "yozildi" | "o'ylab ko'radi" | "rad etdi" | "javob yo'q" | "boshqa"
- interest: mijoz qiziqishi 1–5
- rubric: [{code, points, applicable, evidence}] — yuqoridagi har bir mezon uchun
- socratic_note: SPIN va Sokrat yopish savollari bo'yicha 1–2 jumla (qaysilari berildi, qaysilari o'tkazib yuborildi)
- fab_note: FAB bo'yicha 1–2 jumla (F, A, B qaysi biri bor/yo'q)
- objections: mijoz e'tirozlari (qisqa)
- pains: mijozning og'rig'i / sababi — nega farzandini kursga bermoqchi (masalan: «telefondan uzolmayapti», «kelajak kasbi», «maktabda qiynalyapti»), qisqa, 0–3 ta
- mistakes: [{moment, problem, better}] — moment: vaqt (mm:ss) yoki iqtibos; problem: xato; better: operator aslida nima deyishi kerak edi (tayyor gap)
- good: yaxshi qilingan narsalar
- next_step: keyingi qadam kelishildimi va qanday
- advice: operatorga eng muhim 1 ta maslahat`;

// Step 1 only needs the words and who said them.
const LISTEN_PROMPT = `Audio — Robbit akademiyasi operatori va ota-ona (mijoz) qo'ng'irog'i (o'zbek/rus tilida). Dialogni so'zma-so'z yozing, faqat eshitganingizni.
Har qator "Avtojavob: …" (yozib qo'yilgan ovoz), "Operator: …" (Robbit xodimi) yoki "Mijoz: …" (ota-ona yoki bola). Qo'ng'iroq yo'nalishi: {DIRECTION}. Chiquvchi qo'ng'iroqda birinchi "Allo" degan odatda Mijoz; kiruvchida avtojavobdan keyin birinchi gapirgan odatda Operator. Bitta odamning ketma-ket gaplarini bitta qatorga birlashtiring. Shaxsiy raqam va manzilni [yashirildi] bilan almashtiring.
call_type: "sotuv" (yangi mijozga kurs sotish/maslahat), "eslatma" (dars, to'lov, workshop eslatmasi), "xizmat" (mavjud o'quvchi masalasi), "boshqa".`;
const SCORE_PROMPT = PROMPT
  .replace("Audio — operator va ota-ona (mijoz) qo'ng'irog'i (o'zbek/rus tilida). Faqat eshitganingizga tayaning, o'ylab topmang.", "Quyida operator va ota-ona (mijoz) qo'ng'irog'ining dialogi. Faqat dialogda bor narsaga tayaning, o'ylab topmang.")
  .replace(/- transcript: .*\n/, "");

const STR = { type: "STRING" }, STRS = { type: "ARRAY", items: STR };
const LISTEN_SCHEMA = { type: "OBJECT", properties: { transcript: STR, call_type: STR }, required: ["transcript", "call_type"] };
const SCHEMA = {
  type: "OBJECT",
  properties: {
    call_type: STR, summary: STR, outcome: STR, interest: { type: "INTEGER" },
    rubric: { type: "ARRAY", items: { type: "OBJECT", properties: { code: STR, points: { type: "INTEGER" }, applicable: { type: "BOOLEAN" }, evidence: STR }, required: ["code", "points", "applicable", "evidence"] } },
    socratic_note: STR, fab_note: STR, objections: STRS, pains: STRS,
    mistakes: { type: "ARRAY", items: { type: "OBJECT", properties: { moment: STR, problem: STR, better: STR }, required: ["moment", "problem", "better"] } },
    good: STRS, next_step: STR, advice: STR, script_note: STR,
  },
  required: ["call_type", "summary", "outcome", "interest", "rubric", "socratic_note", "fab_note", "objections", "mistakes", "good", "next_step", "advice"],
};

// Points clamped to each criterion's max; non-applicable criteria leave the denominator, totals scaled to 100.
function score(rubric: Any[]) {
  const by = Object.fromEntries((rubric ?? []).map((r: Any) => [r.code, r]));
  const rows = CRITERIA.map((c) => {
    const r = by[c.code] ?? {};
    return { ...c, applicable: r.applicable !== false, points: Math.max(0, Math.min(c.max, +r.points || 0)), evidence: r.evidence ?? "" };
  });
  const pctOf = (xs: typeof rows) => {
    const max = xs.reduce((a, r) => a + r.max, 0);
    return max ? Math.round(xs.reduce((a, r) => a + r.points, 0) / max * 100) : null;
  };
  const stages = Object.fromEntries(RUBRIC.map(([stage]) => [stage, pctOf(rows.filter((r) => r.stage === stage && r.applicable))]));
  return { rows, stages, total: pctOf(rows.filter((r) => r.applicable)) };
}

async function audioOf(c: Any): Promise<{ data: Uint8Array; mime: string }> {
  let url = "";
  if (c.RECORD_FILE_ID) url = (await bx("disk.file.get", { id: c.RECORD_FILE_ID })).result?.DOWNLOAD_URL ?? "";
  if (!url) url = c.CALL_RECORD_URL ?? "";
  if (!url) throw new Error("yozuv havolasi yo'q");
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`yozuv ${res.status}`);
  const mime = (res.headers.get("content-type") ?? "").split(";")[0];
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.length > 18e6) throw new Error("yozuv juda katta");
  return { data, mime: mime.startsWith("audio/") ? mime : "audio/mpeg" };
}

// One Gemini JSON request, trying each model in turn until one answers or the time runs out.
async function gemini(models: string[], parts: Any[], schema: Any, until: number) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY yo'q");
  const body = JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 } });
  let last = "";
  for (const model of models) {
    const left = until - Date.now();
    if (left < 5000) break;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body, signal: AbortSignal.timeout(Math.min(left, 55000)),
      });
      const r = await res.json();
      if (!res.ok) { last = `${model} ${res.status}: ${r?.error?.message ?? ""}`; continue; }
      const text = (r.candidates?.[0]?.content?.parts ?? []).map((p: Any) => p.text ?? "").join("");
      return { model, ...JSON.parse(text) };
    } catch (e) { last = `${model}: ${e}`; }
  }
  throw new Error(last || "vaqt tugadi");
}

const listen = (audio: { data: Uint8Array; mime: string }, direction: string, until: number) =>
  gemini(MODELS, [{ text: LISTEN_PROMPT.replace("{DIRECTION}", direction || "noma'lum") }, { inlineData: { mimeType: audio.mime, data: encodeBase64(audio.data) } }], LISTEN_SCHEMA, until);

// Company sales script (e.g. the Miro board), stored in audit_settings.sales_script; optional.
const judge = (transcript: string, callType: string, script: string, direction: string, until: number) =>
  gemini(callType === "sotuv" ? SCORE_MODELS : MODELS, [{ text: SCORE_PROMPT.replace("{DIRECTION}", direction || "noma'lum") + (script ? `\n\nKOMPANIYA SOTUV SKRIPTI (operator shunga amal qilishi kerak):\n${script.slice(0, 20000)}\nscript_note: skriptning qaysi bosqichlari bajarildi, qaysilari o'tkazib yuborildi va skriptdagi qaysi gapni aytish kerak edi (1–3 jumla).` : "") + `\n\nDIALOG:\n${transcript}` }], SCHEMA, until);

const idOf = (c: Any) => String(c.CALL_ID ?? c.ID);

// One text request for up to 40 analysed calls without pains; calls with nothing to say get an empty list.
async function backfillPains() {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY yo'q");
  const { data: rows } = await sb.from("call_review").select("call_id, transcript").not("transcript", "is", null).is("pains", null)
    .order("call_start", { ascending: false }).limit(40);
  if (!rows?.length) return 0;
  const text = `Har bir qo'ng'iroq dialogidan mijozning og'rig'i / sababini toping — nega farzandini kursga bermoqchi (masalan: «telefondan uzolmayapti», «kelajak kasbi», «maktabda qiynalyapti»). Qisqa, o'zbek tilida, 0–3 ta. Faqat dialogda aytilganini yozing.\n\n` +
    rows.map((r: Any) => `### ${r.call_id}\n${String(r.transcript).slice(0, 4000)}`).join("\n\n");
  const schema = { type: "ARRAY", items: { type: "OBJECT", properties: { call_id: STR, pains: STRS }, required: ["call_id", "pains"] } };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELS[0]}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, signal: AbortSignal.timeout(110000),
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }], generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 } }),
  });
  const r = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${r?.error?.message ?? ""}`);
  const got = new Map<string, string[]>(JSON.parse((r.candidates?.[0]?.content?.parts ?? []).map((p: Any) => p.text ?? "").join("")).map((x: Any) => [String(x.call_id), x.pains ?? []]));
  for (const row of rows) await sb.from("call_review").update({ pains: got.get(row.call_id) ?? [] }).eq("call_id", row.call_id);
  return rows.length;
}

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "forbidden" }, 403);
  const deadline = Date.now() + BUDGET_MS;
  const params = new URL(req.url).searchParams;
  try {
    if (params.get("pains")) return json({ ok: true, pains: await backfillPains() });
    const since = daysAgo(3).toISOString();
    const { data: cfg } = await sb.from("audit_settings").select("sales_script").eq("id", 1).maybeSingle();
    const script = (cfg?.sales_script ?? "").trim();
    const { data: pending } = await sb.from("call_review").select("call_id, record_file_id, direction, requeue").is("transcript", null)
      .or(`requeue.eq.true,and(error.is.null,call_start.gte."${since}"),and(error.not.like.yozuv*,call_start.gte."${since}")`)
      .order("requeue", { ascending: false, nullsFirst: false }) // calls an admin asked to re-analyse go first
      .order("error", { ascending: true, nullsFirst: true }) // fresh calls before ones that failed before
      .order("call_start", { ascending: false }).limit(50);
    const todo = (pending ?? []).filter((p: Any) => p.record_file_id).slice(0, +(params.get("limit") ?? 0) || LIMIT)
      .map((p: Any) => ({ CALL_ID: p.call_id, RECORD_FILE_ID: p.record_file_id, direction: p.direction }));

    let ok = 0, failed = 0;
    // Scores a saved transcript; on failure the transcript stays and only this step is retried next run.
    const scoreAndSave = async (row: Any, transcript: string, listenedType: string, listenModel: string | null, direction: string) => {
      const until = Math.min(Date.now() + 60_000, deadline + 15_000);
      try {
        const a = await judge(transcript, listenedType, script, direction, until);
        // Only sales calls are scored; reminders and service calls stay out of managers' averages.
        const s = score(a.call_type === "sotuv" ? a.rubric : CRITERIA.map((c) => ({ code: c.code, applicable: false })));
        Object.assign(row, {
          model: listenModel ? `${listenModel} + ${a.model}` : a.model, call_type: a.call_type, summary: a.summary, outcome: a.outcome, interest: a.interest,
          rubric: s.rows.map(({ code, points, applicable, evidence }) => ({ code, points, applicable, evidence })),
          stages: s.stages, total: s.total, score: s.total == null ? null : Math.round(s.total / 10),
          socratic_note: a.socratic_note, fab_note: a.fab_note, objections: a.objections, pains: a.pains ?? [],
          mistakes: (a.mistakes ?? []).map((m: Any) => m.problem), mistakes_detail: a.mistakes,
          good: a.good, next_step: a.next_step, advice: a.advice, script_note: a.script_note ?? null, error: null,
        });
        ok++;
      } catch (e) {
        row.error = ("baho: " + String(e)).slice(0, 500);
        failed++;
      }
      await upsert("call_review", [row], "call_id");
    };
    const one = async (c: Any) => {
      const row: Any = { call_id: idOf(c), analyzed_at: new Date().toISOString(), requeue: false };
      try {
        const heard = await listen(await audioOf(c), c.direction, Math.min(Date.now() + 60_000, deadline));
        row.transcript = heard.transcript;
        await upsert("call_review", [row], "call_id"); // the audio is never sent twice
        await scoreAndSave(row, heard.transcript, heard.call_type, heard.model, c.direction);
      } catch (e) {
        row.error = String(e).slice(0, 500);
        failed++;
        await upsert("call_review", [row], "call_id");
      }
    };
    // Calls already written down but not scored go first: they cost no audio.
    const { data: unscored } = await sb.from("call_review").select("call_id, transcript, call_type, direction").not("transcript", "is", null).is("rubric", null).order("call_start", { ascending: false }).limit(LIMIT);
    for (const u of unscored ?? []) {
      if (Date.now() > deadline - 75_000) break;
      await scoreAndSave({ call_id: u.call_id, analyzed_at: new Date().toISOString() }, u.transcript, u.call_type ?? "sotuv", null, u.direction);
      await sleep(1500);
    }
    for (let i = 0; i < todo.length && Date.now() < deadline - 75_000; i += PARALLEL) {
      await Promise.all(todo.slice(i, i + PARALLEL).map(one));
      await sleep(2000); // stay under the free-tier requests/minute limit
    }
    const { error: taskErr } = await sb.rpc("generate_call_tasks");
    if (taskErr) console.error("generate_call_tasks", taskErr.message);
    const { count } = await sb.from("call_review").select("call_id", { count: "exact", head: true }).is("transcript", null).gte("call_start", since);
    return json({ ok: true, analysed: ok, failed, pending: count });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
