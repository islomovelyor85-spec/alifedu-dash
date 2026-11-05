// AI assistant for the sales-audit dashboard: answers questions about the selected period using the
// platform's own aggregates (leads, stages, sources, operators, ad spend). Admins only.
//   POST { from, to, messages: [{ role: "user" | "assistant", content }] } → { answer }
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { KNOWLEDGE } from "./knowledge.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
const json = (d: Any, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });

const SYSTEM = `Siz Robbit akademiyasi (bolalar uchun robototexnika va dasturlash, O'zbekistonning bir necha filiali) sotuv va marketing tahlilchisisiz.
Sizga platformadagi haqiqiy raqamlar JSON ko'rinishida beriladi: Bitrix leadlari va stadiyalari, deallar, manbalar, operatorlar, Meta reklama xarajati.
Qoidalar:
- Faqat o'zbek tilida, qisqa va aniq javob bering.
- Har bir xulosaga raqam keltiring; berilgan ma'lumotda yo'q narsani o'ylab topmang — yo'q bo'lsa, ochiq ayting.
- Eng zaif bosqichni (eng ko'p yo'qotish) toping va 1–3 ta aniq, sinab ko'rsa bo'ladigan harakat taklif qiling: qanday o'zgarish, qaysi ko'rsatkich qancha o'zgarishi kutiladi, qancha muddat sinash.
- Joriy oy leadlarining sotuvi hali "pishmagan" bo'lishi mumkin (sotuvlarning katta qismi keyingi oyda bo'ladi) — buni hisobga oling.
- Reklama xarajati ad_currency valyutasida; so'mga fx_rate bilan aylantiring.
- Javob berishda quyidagi maslahatchi skill'lardan mosini ishlating (growth-advisor, meta-ads-strategist, performance-marketer, digital-marketing-strategist): ularning protsedurasi va formatiga amal qiling.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // The caller's own session: RLS limits every read to admins.
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { authorization: req.headers.get("authorization") ?? "" } },
      auth: { persistSession: false },
    });
    const { data: isAdmin } = await sb.rpc("is_admin");
    if (!isAdmin) return json({ error: "Faqat adminlar uchun" }, 403);
    const gemini = Deno.env.get("GEMINI_API_KEY");
    if (!gemini && !Deno.env.get("ANTHROPIC_API_KEY")) {
      return json({ error: "AI ulanmagan: Supabase Secrets'ga GEMINI_API_KEY (bepul) yoki ANTHROPIC_API_KEY qo'shing." }, 400);
    }

    const { from, to, messages } = await req.json();
    const day = (q: Any) => q.gte("day", from).lte("day", to);
    const sel = async (table: string, build = (q: Any) => q) => (await build(sb.from(table).select("*")).limit(5000)).data ?? [];
    const sum = (rows: Any[], key: string, fields: string[]) => {
      const by: Record<string, Any> = {};
      for (const r of rows) {
        const o = by[r[key]] ??= { [key]: r[key] };
        for (const f of fields) o[f] = (o[f] ?? 0) + (+r[f] || 0);
      }
      return Object.values(by).sort((a: Any, b: Any) => (b[fields[0]] ?? 0) - (a[fields[0]] ?? 0));
    };
    const OUT = ["leads", "contacted", "qual", "deals", "came_to_branch", "paid", "won", "in_progress", "deal_lost", "junk", "revenue"];
    const [daily, ops, status, deals, spend, cohort, cfg] = await Promise.all([
      sel("v_daily_outcomes", day), sel("v_operator_outcomes", day), sel("v_status_outcomes", day),
      sel("v_deal_stages", day), sel("v_spend_daily", day), sel("v_cohort_summary"),
      sel("audit_settings").then((r) => r[0] ?? {}),
    ]);
    const context = {
      period: { from, to },
      currency: { ad_currency: cfg.ad_currency, fx_rate: cfg.fx_rate },
      totals: sum(daily.map((r: Any) => ({ ...r, period: "all" })), "period", OUT)[0] ?? {},
      by_source: sum(daily, "source", OUT),
      by_lead_stage: sum(status, "status_name", ["leads", "won", "junk"]),
      by_deal_stage: sum(deals, "stage_name", ["deals", "amount"]),
      by_operator: sum(ops, "operator", OUT).slice(0, 15),
      ad_spend_by_branch: sum(spend.map((r: Any) => ({ ...r, branch: r.branch ?? "noma'lum" })), "branch", ["spend", "meta_leads", "clicks", "impressions"]),
      by_day: sum(daily, "day", ["leads", "qual", "won", "junk"]).sort((a: Any, b: Any) => String(a.day).localeCompare(String(b.day))),
      cohort_by_lead_month: cohort,
    };

    const history = (Array.isArray(messages) ? messages : []).slice(-12)
      .filter((m: Any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m: Any) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!history.length || history[history.length - 1].role !== "user") return json({ error: "Savol bo'sh" }, 400);
    // Data goes first in the opening user turn so the system prompt stays a stable cacheable prefix.
    history[0] = { role: "user", content: `Platforma ma'lumotlari (JSON):\n${JSON.stringify(context)}\n\nSavol: ${history[0].content}` };

    // Free tier: Google Gemini when GEMINI_API_KEY is set; otherwise Claude.
    if (gemini) {
      // Free tier is often overloaded (503) or rate-limited (429): fall through lighter models.
      const models = [Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash", "gemini-flash-latest", "gemini-flash-lite-latest"];
      const payload = JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM + "\n\n" + KNOWLEDGE }] },
        contents: history.map((m: Any) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      });
      let last = "";
      for (const model of models) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": gemini },
            body: payload, signal: AbortSignal.timeout(40000),
          });
          const body = await res.json();
          if (!res.ok) { last = `${res.status}: ${body?.error?.message ?? ""}`; continue; }
          const answer = (body.candidates?.[0]?.content?.parts ?? []).map((p: Any) => p.text ?? "").join("").trim();
          if (answer) return json({ answer });
          last = "bo'sh javob";
        } catch (e) { last = String(e); }
      }
      return json({ error: `AI hozir band (Gemini ${last}). Bir daqiqadan keyin qayta yuboring.` }, 503);
    }

    const response = await new Anthropic().beta.messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      // Stable prefix (rules + advisor skills) cached across questions.
      system: [{ type: "text", text: SYSTEM + "\n\n" + KNOWLEDGE, cache_control: { type: "ephemeral" } }],
      messages: history,
    } as Any);
    if (response.stop_reason === "refusal") return json({ answer: "Bu so'rovga javob bera olmayman. Savolni boshqacha bering." });
    const answer = response.content.filter((b: Any) => b.type === "text").map((b: Any) => b.text).join("\n").trim();
    return json({ answer: answer || "Javob bo'sh qaytdi." });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "ANTHROPIC_API_KEY noto'g'ri." }, 400);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "AI band — birozdan keyin qayta urinib ko'ring." }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: `AI xatosi ${e.status}: ${e.message}` }, 502);
    return json({ error: String(e) }, 500);
  }
});
