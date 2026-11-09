// "Yangi brief" button: an admin asks Gemini for ad briefs built from the last 30 days of leads and calls.
//   POST /brief-generate   (Authorization: the admin's session) → { created }
// Inputs: why leads were lost (Bitrix statuses), what parents said in analysed calls (pains, objections),
// and which ads brought qualified leads. Each brief is a ready ad script: hook, body, CTA.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { Any, sb } from "../_shared/sync.ts";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
// Free-tier quota is per model: a 429 moves on to the next one.
const MODELS = [Deno.env.get("GEMINI_TEXT_MODEL") ?? "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3-flash-preview", "gemini-flash-lite-latest"];

const top = (items: string[], n: number) => Object.entries(items.reduce((m: Record<string, number>, x) => {
  const k = x.toLowerCase().trim(); if (k) m[k] = (m[k] ?? 0) + 1; return m;
}, {})).sort((a, b) => b[1] - a[1]).slice(0, n);

const STR = { type: "STRING" };
const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: { pain_code: STR, offer_type: STR, hook: STR, body: STR, cta: STR, script: STR, evidence: STR },
    required: ["pain_code", "offer_type", "hook", "body", "cta", "script", "evidence"],
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { authorization: req.headers.get("authorization") ?? "" } }, auth: { persistSession: false },
  });
  const { data: isAdmin } = await user.rpc("is_admin");
  if (!isAdmin) return json({ error: "Faqat adminlar uchun" }, 403);
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "GEMINI_API_KEY yo'q" }, 500);

  try {
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const [{ data: status }, { data: calls }, { data: ads }] = await Promise.all([
      sb.from("v_status_outcomes").select("status_name, leads, qual, won").gte("day", since),
      sb.from("call_review").select("pains, objections, outcome, summary").not("transcript", "is", null).gte("call_start", since).limit(600),
      sb.from("v_ad_week").select("ad_id, leads, qual_leads, spend").gte("week", since),
    ]);
    const byStatus: Record<string, number> = {};
    let leads = 0;
    for (const r of status ?? []) { byStatus[r.status_name] = (byStatus[r.status_name] ?? 0) + +r.leads; leads += +r.leads; }
    const statusLines = Object.entries(byStatus).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([k, n]) => `- ${k}: ${n} (${(n / Math.max(leads, 1) * 100).toFixed(0)}%)`).join("\n");
    const cs = calls ?? [];
    const pains = top(cs.flatMap((c: Any) => c.pains ?? []), 15).map(([k, n]) => `- ${k}: ${n}`).join("\n");
    const objections = top(cs.flatMap((c: Any) => c.objections ?? []), 15).map(([k, n]) => `- ${k}: ${n}`).join("\n");
    const booked = cs.filter((c: Any) => c.outcome === "yozildi").slice(0, 8).map((c: Any) => `- ${c.summary}`).join("\n");

    const byAd: Record<string, { leads: number; qual: number; spend: number }> = {};
    for (const r of ads ?? []) { const o = byAd[r.ad_id] ??= { leads: 0, qual: 0, spend: 0 }; o.leads += +r.leads; o.qual += +r.qual_leads; o.spend += +r.spend; }
    const ids = Object.entries(byAd).filter(([, o]) => o.qual >= 2).sort((a, b) => a[1].spend / a[1].qual - b[1].spend / b[1].qual).slice(0, 5).map(([id]) => id);
    const { data: names } = ids.length ? await sb.from("ads").select("id, name").in("id", ids) : { data: [] };
    const bestAds = ids.map((id) => { const o = byAd[id]; return `- ${names?.find((n: Any) => n.id === id)?.name ?? id}: ${o.qual} sifatli lead, $${(o.spend / o.qual).toFixed(2)} / sifatli`; }).join("\n");

    const prompt = `Siz Robbit akademiyasi (8–14 yoshli bolalar uchun robototexnika, dasturlash, sun'iy intellekt kurslari, O'zbekiston, filiallar viloyatlarda) uchun Meta (Instagram/Facebook) reklama strategisiz.
Quyida oxirgi 30 kunlik haqiqiy ma'lumot. Shunga tayanib 4 ta reklama briefi yozing — har biri aniq bir muammoni hal qilsin.

LEADLAR NATIJASI (Bitrix statuslari, ${leads} ta lead):
${statusLines || "- ma'lumot yo'q"}

OTA-ONALAR QO'NG'IROQDA AYTGAN OG'RIQLAR (nega kursga bermoqchi):
${pains || "- hali yig'ilmagan"}

E'TIROZLAR:
${objections || "- ma'lumot yo'q"}

YOZILGAN (muvaffaqiyatli) QO'NG'IROQLAR XULOSASI:
${booked || "- yo'q"}

ENG ARZON SIFATLI LEAD BERGAN REKLAMALAR:
${bestAds || "- yo'q"}

Har bir brief uchun (o'zbek tilida, lotin yozuvida, ota-onaga qaratilgan):
- pain_code: qisqa ingliz kodi (masalan far_location, price, gadget_time, future_career)
- offer_type: PAIN | PRICE | OTHER
- hook: videoning birinchi 3 soniyasi — ekrandagi matn va ovozdagi gap (1–2 jumla, to'xtatib qo'yadigan)
- body: 15–25 soniyalik asosiy qism — kadrlar ketma-ketligi va ovoz matni (3–5 jumla)
- cta: oxirgi chaqiriq — aniq harakat va taklif (1 jumla)
- script: Muammo / Target auditoriya / Format / O'lchov (qaysi raqam qanchaga o'zgarishi kerak) — har biri yangi qatordan
- evidence: bu brief yuqoridagi qaysi raqamga asoslangani (1 jumla)
Raqam va va'dalarni o'ylab topmang: narx, chegirma, kafolat aytilmagan bo'lsa yozmang.`;

    let r: Any = null, failure = "";
    for (const model of MODELS) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, signal: AbortSignal.timeout(100000),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.7 } }),
      });
      const body = await res.json();
      if (res.ok) { r = body; break; }
      failure = `${model} ${res.status}: ${body?.error?.message ?? ""}`;
    }
    if (!r) throw new Error(failure);
    const briefs = JSON.parse((r.candidates?.[0]?.content?.parts ?? []).map((p: Any) => p.text ?? "").join(""));
    const monday = new Date(); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const rows = briefs.slice(0, 6).map((b: Any) => ({
      week: monday.toISOString().slice(0, 10), course: "ROBBIT", status: "draft",
      pain_code: b.pain_code, offer_type: b.offer_type, hook: b.hook, body: b.body, cta: b.cta, script: b.script, evidence: b.evidence,
    }));
    const { error } = await sb.from("briefs").insert(rows);
    if (error) throw new Error(error.message);
    return json({ created: rows.length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
