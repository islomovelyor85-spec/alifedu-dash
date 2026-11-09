// Telegram alert when a day looks wrong. Each alert goes out once (audit_settings.alerts_sent).
//   POST /audit-alerts   hourly
import { Any, authorized, json, sb } from "../_shared/sync.ts";

const TOKEN = Deno.env.get("TG_BOT_TOKEN") ?? "";
const tg = (method: string, body: Any) => fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s + "T00:00:00Z") + n * 864e5));
const esc = (s: string) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as Any)[c]);
const sum = (rows: Any[], f: string) => rows.reduce((a, r) => a + (+r[f] || 0), 0);

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "forbidden" }, 403);
  if (!TOKEN) return json({ error: "TG_BOT_TOKEN is not set" }, 400);
  try {
    const now = new Date(Date.now() + 5 * 3600e3), today = iso(now), hour = now.getUTCHours(), y = addDays(today, -1), p0 = addDays(y, -7);
    const [{ data: cfg }, { data: daily }, { data: spend }] = await Promise.all([
      sb.from("audit_settings").select("tg_chat_id, alerts_sent, ad_currency").eq("id", 1).single(),
      sb.from("v_daily_outcomes").select("day, source, leads, qual").gte("day", p0).limit(5000),
      sb.from("v_spend_daily").select("day, spend").gte("day", p0).limit(5000),
    ]);
    const chat = Deno.env.get("TG_CHAT_ID") ?? cfg?.tg_chat_id;
    if (!chat) return json({ error: "no chat" }, 400);
    const usd = (n: number) => (cfg?.ad_currency === "USD" ? "$" : "") + n.toFixed(0);
    const rows = daily ?? [], ofDay = (d: string) => rows.filter((r: Any) => r.day === d);
    const prev = rows.filter((r: Any) => r.day >= p0 && r.day < y), spendOf = (d: string) => sum((spend ?? []).filter((r: Any) => r.day === d), "spend");
    const avgSpend = sum((spend ?? []).filter((r: Any) => r.day >= p0 && r.day < y), "spend") / 7;
    const alerts: [string, string][] = [];

    // Yesterday: a source with many leads and no qualified one.
    const bySrc: Record<string, Any> = {};
    for (const r of ofDay(y)) { const o = bySrc[r.source] ??= { leads: 0, qual: 0 }; o.leads += +r.leads; o.qual += +r.qual; }
    for (const [src, o] of Object.entries(bySrc)) if (o.leads >= 30 && !o.qual) alerts.push([`noqual:${y}:${src}`, `«${esc(src)}»: kecha ${o.leads} ta lead, sifatli 0. Bu leadlar haqiqiy mijozmi, tekshiring.`]);
    // Yesterday: qualified share fell by half against the previous 7 days.
    const yL = sum(ofDay(y), "leads"), yQ = sum(ofDay(y), "qual"), pL = sum(prev, "leads"), pQ = sum(prev, "qual");
    if (yL >= 50 && pL && yQ / yL < (pQ / pL) * 0.5) alerts.push([`qualdrop:${y}`, `Kecha sifatli lead ulushi ${(yQ / yL * 100).toFixed(1)}%, oldingi 7 kunda ${(pQ / pL * 100).toFixed(1)}%.`]);
    // Yesterday: ads stopped, or spend jumped.
    const yS = spendOf(y);
    if (avgSpend >= 20 && yS < avgSpend * 0.2) alerts.push([`spendstop:${y}`, `Kecha reklama xarajati ${usd(yS)}, o'rtacha ${usd(avgSpend)}. Reklama to'xtab qolgan bo'lishi mumkin.`]);
    if (avgSpend >= 20 && yS > avgSpend * 1.8) alerts.push([`spendjump:${y}`, `Kecha reklama xarajati ${usd(yS)}, o'rtacha ${usd(avgSpend)}.`]);
    // Today: money is going out but Target brings nothing into Bitrix.
    const tS = spendOf(today), tL = sum(ofDay(today).filter((r: Any) => r.source === "Target"), "leads");
    if (hour >= 14 && tS >= 10 && !tL) alerts.push([`nolead:${today}`, `Bugun reklamaga ${usd(tS)} ketdi, lekin Bitrix'ga Target'dan lead tushmadi. Lead forma va integratsiyani tekshiring.`]);

    const sent: Record<string, string> = { ...(cfg?.alerts_sent ?? {}) };
    const fresh = alerts.filter(([k]) => !sent[k]);
    if (fresh.length) {
      const res = await tg("sendMessage", { chat_id: chat, text: `🚨 <b>Diqqat</b>\n\n${fresh.map(([, t]) => "• " + t).join("\n\n")}`, parse_mode: "HTML" });
      if (!res.ok) return json({ error: res.description }, 500);
      for (const [k] of fresh) sent[k] = today;
    }
    const cut = addDays(today, -14);
    await sb.from("audit_settings").update({ alerts_sent: Object.fromEntries(Object.entries(sent).filter(([, d]) => d >= cut)) }).eq("id", 1);
    return json({ ok: true, alerts: alerts.length, sent: fresh.length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
