// Telegram reports for the sales audit (separate bot: env TG_BOT_TOKEN, chat TG_CHAT_ID or auto-detected).
//   POST /audit-report?mode=daily    07:00 Tashkent: yesterday's leads, problems vs the previous 7 days
//   POST /audit-report?mode=status   every 4 hours: today so far, untouched leads, spend
// Each run sends Target (with ad spend), Звонок, and one message with every other source.
import { Any, authorized, json, sb } from "../_shared/sync.ts";
import { KNOWLEDGE } from "./knowledge.ts";

const TOKEN = Deno.env.get("TG_BOT_TOKEN") ?? "";
const tg = (method: string, body: Any) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

const num = (n: number) => Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");
const esc = (s: string) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as Any)[c]);
const tashkent = (d = new Date()) => new Date(d.getTime() + 5 * 3600e3); // UTC+5, no DST
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s + "T00:00:00Z") + n * 864e5));
const MON = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentyabr", "oktyabr", "noyabr", "dekabr"];
const human = (s: string) => `${+s.slice(8)}-${MON[+s.slice(5, 7) - 1]}`;

async function chatId() {
  const env = Deno.env.get("TG_CHAT_ID");
  if (env) return env;
  const { data } = await sb.from("audit_settings").select("tg_chat_id").eq("id", 1).single();
  if (data?.tg_chat_id) return data.tg_chat_id;
  // First run: take the chat that sent /start to the bot.
  const upd = await tg("getUpdates", { limit: 50 });
  const chat = [...(upd.result ?? [])].reverse().map((u: Any) => (u.message ?? u.my_chat_member)?.chat?.id).find(Boolean);
  if (chat) await sb.from("audit_settings").update({ tg_chat_id: String(chat) }).eq("id", 1);
  return chat ? String(chat) : null;
}

// Lead statuses grouped the way the sales team reads them.
const GROUPS: [string, string, string[]][] = [
  ["Jarayondagi lidlar", "#64d2ff", ["Не обработан / Propushniy", "Yangi lead", "Bog'lanib bo'lmadi", "Qayta aloqa", "Qaytgan lidlar"]],
  ["Sifatli lidlar", "#30d158", ["Качественный лид", "Boshqa raqami bor (Dublikat)", "Ko'p o'ylayapti", "Rus tilida kurs kerak", "Keyinroq o'qiydi", "Bizda yo'q kurs", "Xususiy maktabda o'qiydi", "Musobaqa uchun Farg'ona"]],
  ["Sifatsiz lidlar", "#ff375f", ["Lokatsiya to'g'ri kelmadi (boshqa viloyat)", "Yoshi to'g'ri kelmaydi", "SPAM", "Boshqa struktura (Najot Ta'lim)", "Maktab deb o'ylabdi", "6 marta bog'lanib bo'lmadi", "Bu yerga chiqazilmasin (Eski baza)", "Osmondagi bolalar"]],
];
const groupOf = (name: string) => GROUPS.find(([, , names]) => names.includes(name)) ?? GROUPS[2];
const pct1 = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1).replace(".", ",") + "%" : "—");
function statusBlock(byStatus: Record<string, number>, total: number) {
  return GROUPS.map(([title, , names]) => {
    const rows = Object.entries(byStatus).filter(([n]) => groupOf(n)[2] === names && byStatus[n] > 0).sort((a, b) => b[1] - a[1]);
    const sum = rows.reduce((a, [, v]) => a + v, 0);
    return rows.length ? `<b>${title}</b> — ${num(sum)} (${pct1(sum, total)})\n` + rows.map(([n, v]) => `  ${esc(n)}: ${num(v)} (${pct1(v, total)})`).join("\n") : "";
  }).filter(Boolean).join("\n\n");
}
// Horizontal bar chart of every status, coloured by group (QuickChart renders it as PNG).
async function chartUrl(byStatus: Record<string, number>, title: string) {
  const rows = Object.entries(byStatus).filter(([, v]) => v > 0).sort((a, b) => GROUPS.indexOf(groupOf(a[0])) - GROUPS.indexOf(groupOf(b[0])) || b[1] - a[1]);
  const chart = {
    type: "horizontalBar",
    data: { labels: rows.map(([n]) => n.length > 34 ? n.slice(0, 33) + "…" : n), datasets: [{ data: rows.map(([, v]) => v), backgroundColor: rows.map(([n]) => groupOf(n)[1]) }] },
    options: {
      title: { display: true, text: title, fontColor: "#f5f5f7", fontSize: 18 },
      legend: { display: false },
      scales: { xAxes: [{ ticks: { fontColor: "#8e8e93", beginAtZero: true }, gridLines: { color: "#2c2c2e" } }], yAxes: [{ ticks: { fontColor: "#f5f5f7" }, gridLines: { display: false } }] },
      plugins: { datalabels: { anchor: "end", align: "right", color: "#f5f5f7", font: { weight: "bold" } } },
    },
  };
  const res = await fetch("https://quickchart.io/chart/create", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chart, backgroundColor: "#000000", width: 900, height: Math.max(420, rows.length * 34 + 120), format: "png" }) }).then((r) => r.json()).catch(() => null);
  return res?.url ?? null;
}

const sumRows = (rows: Any[], f: string) => rows.reduce((a, r) => a + (+r[f] || 0), 0);
// Reports go out per source: Target (with ad spend), Звонок, then every other source in one message.
const TARGET = "Target", CALL = "Звонок";
const UNTOUCHED = ["Не обработан / Propushniy", "Yangi lead"];
const reportRows = async (from: string, to: string) =>
  (await sb.from("v_report_leads").select("*").gte("day", from).lte("day", to).limit(20000)).data ?? [];
function stats(rows: Any[]) {
  const t = Object.fromEntries(["leads", "contacted", "qual", "won", "junk", "in_progress"].map((k) => [k, sumRows(rows, k)]));
  const byStatus: Record<string, number> = {}, open: Record<string, number> = {}, opBy: Record<string, Any> = {};
  for (const r of rows) {
    byStatus[r.status_name] = (byStatus[r.status_name] ?? 0) + +r.leads;
    if (r.outcome === "open") open[r.status_name] = (open[r.status_name] ?? 0) + +r.leads;
    const o = opBy[r.operator] ??= { leads: 0, qual: 0 }; o.leads += +r.leads; o.qual += +r.qual;
  }
  const untouched = UNTOUCHED.reduce((a, k) => a + (open[k] ?? 0), 0);
  return { ...t, byStatus, open, opBy, untouched } as Any;
}
const spendOf = async (from: string, to: string) => {
  const rows = (await sb.from("v_spend_daily").select("spend,meta_leads").gte("day", from).lte("day", to).limit(5000)).data ?? [];
  return { spend: sumRows(rows, "spend"), metaLeads: sumRows(rows, "meta_leads") };
};
const opsLine = (opBy: Record<string, Any>) => {
  const ops = Object.entries(opBy).filter(([, o]: Any) => o.leads >= 15).map(([n, o]: Any) => [n, o.qual / o.leads] as [string, number]).sort((a, b) => b[1] - a[1]);
  return ops.length > 1 ? `<b>Operatorlar (sifatli %):</b> eng yaxshi ${esc(ops[0][0])} ${(ops[0][1] * 100).toFixed(0)}%, eng past ${esc(ops[ops.length - 1][0])} ${(ops[ops.length - 1][1] * 100).toFixed(0)}%` : "";
};
// Compact block for the "other sources" message.
const shortBlock = (name: string, c: Any) => `<b>${esc(name)}</b> — ${num(c.leads)} lead · sifatli ${num(c.qual)} (${pct1(c.qual, c.leads)}) · sifatsiz ${num(c.junk)} · jarayonda ${num(c.in_progress)}` +
  (c.untouched ? ` · <b>ishlov berilmagan ${num(c.untouched)}</b>` : "");

type Report = { text: string; chart?: { byStatus: Record<string, number>; title: string } };

async function daily(): Promise<Report[]> {
  const today = iso(tashkent()), y = addDays(today, -1), p0 = addDays(y, -7), p1 = addDays(y, -1);
  const [rows, prevRows, sp, spPrev, cfgRes] = await Promise.all([reportRows(y, y), reportRows(p0, p1), spendOf(y, y), spendOf(p0, p1),
    sb.from("audit_settings").select("ad_currency,fx_rate").eq("id", 1).single()]);
  const usd = (n: number) => (cfgRes.data?.ad_currency === "USD" ? "$" : "") + (n >= 100 ? num(n) : (n || 0).toFixed(2));
  const one = (src: string, withAds: boolean): Report => {
    const cur = stats(rows.filter((r: Any) => r.source === src)), prev = stats(prevRows.filter((r: Any) => r.source === src));
    const avg = (k: string) => prev[k] / 7;
    const problems: string[] = [];
    if (cur.leads < avg("leads") * 0.8) problems.push(`Leadlar kam: ${num(cur.leads)} (7 kunlik o'rtacha ${num(avg("leads"))}, ${pct(cur.leads - avg("leads"), avg("leads"))})`);
    if (cur.leads >= 30 && cur.qual / cur.leads < (prev.qual / (prev.leads || 1)) * 0.8) problems.push(`Sifatli lead ulushi tushdi: ${pct(cur.qual, cur.leads)} (oldin ${pct(prev.qual, prev.leads)})`);
    if (cur.leads >= 30 && cur.junk / cur.leads > (prev.junk / (prev.leads || 1)) * 1.15) problems.push(`Sifatsiz leadlar ko'paydi: ${pct(cur.junk, cur.leads)} (oldin ${pct(prev.junk, prev.leads)})`);
    if (cur.untouched) problems.push(`Ishlov berilmagan leadlar: ${num(cur.untouched)} ta (hali qo'ng'iroq qilinmagan)`);
    let ads = "";
    if (withAds && sp.spend) {
      const cpl = sp.spend / (cur.leads || 1), cplPrev = spPrev.spend / (prev.leads || 1);
      if (cplPrev && cpl > cplPrev * 1.2) problems.push(`Lead narxi oshdi: ${usd(cpl)} (oldin ${usd(cplPrev)})`);
      const gap = sp.metaLeads - cur.leads;
      if (sp.metaLeads && gap > sp.metaLeads * 0.25) problems.push(`Meta ${num(sp.metaLeads)} lead hisobladi, Bitrix'ga ${num(cur.leads)} ta tushdi — ${num(gap)} ta yo'qolgan bo'lishi mumkin`);
      ads = `Reklama: ${usd(sp.spend)} · lead narxi ${usd(cpl)} · CPQL ${usd(sp.spend / Math.max(1, cur.qual))}`;
    }
    if (withAds) scenarioInput = { day: y, source: src, problems, yesterday: { ...cur, opBy: undefined }, avg7: Object.fromEntries(["leads", "contacted", "qual", "won", "junk"].map((k) => [k, avg(k)])), spend: sp };
    return {
      chart: cur.leads ? { byStatus: cur.byStatus, title: `${src} · ${human(y)} — ${num(cur.leads)} ta lead` } : undefined,
      text: [
        `📊 <b>${esc(src)} — ${human(y)}</b>`,
        ``,
        `Leadlar: <b>${num(cur.leads)}</b> (o'rtacha ${num(avg("leads"))})`,
        `Aloqa qilindi: ${num(cur.contacted)} · ${pct(cur.contacted, cur.leads)}`,
        `Sifatli: <b>${num(cur.qual)}</b> · ${pct(cur.qual, cur.leads)}`,
        `Sifatsiz yopildi: ${num(cur.junk)} · ${pct(cur.junk, cur.leads)}`,
        `Sotuv (shu kun leadlaridan): ${num(cur.won)}`,
        ads,
        cur.leads ? "\n" + statusBlock(cur.byStatus, cur.leads) + "\n" : "",
        opsLine(cur.opBy),
        ``,
        problems.length ? `⚠️ <b>Muammolar:</b>\n` + problems.map((p) => `• ${p}`).join("\n") : `✅ Katta muammo topilmadi.`,
      ].filter((x) => x !== "").join("\n"),
    };
  };
  return [one(TARGET, true), one(CALL, false), others(rows, `📋 <b>Boshqa manbalar — ${human(y)}</b>`)];
}

function others(rows: Any[], title: string): Report {
  const by: Record<string, Any[]> = {};
  for (const r of rows) if (r.source !== TARGET && r.source !== CALL) (by[r.source] ??= []).push(r);
  const list = Object.entries(by).map(([n, rs]) => [n, stats(rs)] as [string, Any]).sort((a, b) => b[1].leads - a[1].leads);
  return { text: title + "\n\n" + (list.length ? list.map(([n, c]) => shortBlock(n, c)).join("\n\n") : "Boshqa manbalardan lead yo'q.") };
}

// Auto-scenarios: every daily report, with a fresh market check (Gemini + Google Search), the advisor knowledge turns problems and market changes into 2–3 concrete plans.
let scenarioInput: Any = null, scenarioError = "";
async function scenarios(input: Any) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return null;
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";
  const prompt = `Robbit akademiyasi (bolalar robototexnika/dasturlash kurslari, O'zbekiston filiallari) kunlik hisoboti. Ma'lumot (JSON):\n${JSON.stringify(input)}\n\n` +
    `Avval Google qidiruv bilan shu haftadagi bozorni tekshiring: O'zbekistonda bolalar IT/robototexnika kurslari raqobatchilari va ularning takliflari, Meta reklama o'zgarishlari, mavsum (ta'tillar, bayramlar, o'quv yili). ` +
    `Keyin bitta qatorda "Bozor:" deb eng muhim o'zgarishni yozing, so'ng muammolar va bozorni hisobga olib jami 2–3 ssenariy yozing: "Agar … → nima qilamiz → kutilgan natija (raqam bilan) → qachon tekshiramiz". Eng arzon va qaytariladiganini birinchi qo'ying. ` +
    `Faqat o'zbek tilida, oddiy matn (markdown va HTML yo'q), jami 1200 belgidan oshmasin. Berilmagan raqamni o'ylab topmang.`;
  // Free-tier quotas differ by model and by Google Search grounding: fall back step by step.
  // Each try is capped at 30 s so the whole report stays under the 150 s edge limit.
  const tries: [string, boolean][] = [[model, true], [model, false], ["gemini-flash-latest", false]];
  for (const [m, search] of tries) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ systemInstruction: { parts: [{ text: KNOWLEDGE }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], ...(search ? { tools: [{ google_search: {} }] } : {}) }),
    }).then((r) => r.json()).catch((e) => ({ error: { message: String(e) } }));
    if (res?.error) { scenarioError = `${m}${search ? "+search" : ""}: ${res.error.message}`.slice(0, 200); continue; }
    const text = (res?.candidates?.[0]?.content?.parts ?? []).map((p: Any) => p.text ?? "").join("").trim();
    if (text) return text.replace(/\*\*/g, "").slice(0, 3500);
  }
  return null;
}

async function status(): Promise<Report[]> {
  const now = tashkent(), today = iso(now), hour = now.getUTCHours(), hh = String(hour).padStart(2, "0");
  const [rows, prevRows, sp] = await Promise.all([reportRows(today, today), reportRows(addDays(today, -7), addDays(today, -1)), spendOf(today, today)]);
  const { data: cfg } = await sb.from("audit_settings").select("ad_currency").eq("id", 1).single();
  const usd = (n: number) => (cfg?.ad_currency === "USD" ? "$" : "") + (n >= 100 ? num(n) : (n || 0).toFixed(2));
  const one = (src: string, withAds: boolean): Report => {
    const cur = stats(rows.filter((r: Any) => r.source === src));
    // Same part of the day over the previous 7 days.
    const avgSoFar = sumRows(prevRows.filter((r: Any) => r.source === src && r.hour < hour), "leads") / 7;
    const warn = [
      cur.leads < avgSoFar * 0.8 ? `Leadlar odatdagidan kam (${num(cur.leads)} / o'rtacha ${num(avgSoFar)})` : "",
      cur.untouched >= 10 ? `${num(cur.untouched)} ta lead hali ishlov berilmagan — tezroq qo'ng'iroq qiling` : "",
    ].filter(Boolean);
    return {
      chart: cur.leads ? { byStatus: cur.byStatus, title: `${src} · bugun ${hh}:00 gacha — ${num(cur.leads)} ta lead` } : undefined,
      text: [
        `🕐 <b>${esc(src)} — ${hh}:00</b> (bugun)`,
        `Leadlar: <b>${num(cur.leads)}</b> (shu vaqtgacha o'rtacha ${num(avgSoFar)})`,
        `Aloqa qilindi: ${num(cur.contacted)} · Sifatli: ${num(cur.qual)} · Sifatsiz: ${num(cur.junk)}`,
        `Ishlov berilmagan: <b>${num(cur.untouched)}</b>`,
        cur.leads ? "\n" + statusBlock(cur.byStatus, cur.leads) + "\n" : "",
        withAds && sp.spend ? `Reklama bugun: ${usd(sp.spend)} · Meta lead ${num(sp.metaLeads)}` : "",
        warn.length ? `⚠️ ` + warn.join("\n⚠️ ") : "",
      ].filter(Boolean).join("\n"),
    };
  };
  return [one(TARGET, true), one(CALL, false), others(rows, `📋 <b>Boshqa manbalar — bugun ${hh}:00 gacha</b>`)];
}

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "forbidden" }, 403);
  if (!TOKEN) return json({ error: "TG_BOT_TOKEN is not set" }, 400);
  try {
    const chat = await chatId();
    if (!chat) return json({ error: "no chat: send /start to the bot or set TG_CHAT_ID" }, 400);
    const mode = new URL(req.url).searchParams.get("mode") ?? "status";
    const reports = mode === "daily" ? await daily() : await status();
    // Each report: chart first (photo), then its text.
    const sent: Any[] = [];
    for (const r of reports) {
      const photo = r.chart ? await chartUrl(r.chart.byStatus, r.chart.title) : null;
      if (photo) await tg("sendPhoto", { chat_id: chat, photo });
      const res = await tg("sendMessage", { chat_id: chat, text: r.text, parse_mode: "HTML", disable_web_page_preview: true });
      sent.push({ ok: res.ok, chart: !!photo, error: res.description });
    }
    const plan = mode === "daily" && scenarioInput ? await scenarios(scenarioInput) : null;
    if (plan) await tg("sendMessage", { chat_id: chat, text: `🧭 <b>Taklif etilgan ssenariylar (Target)</b>\n\n${esc(plan)}`, parse_mode: "HTML" });
    return json({ ok: sent.every((x) => x.ok), mode, sent, scenarios: !!plan, scenarioError: plan ? undefined : scenarioError });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
