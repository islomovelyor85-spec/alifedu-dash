// Sends qualified leads and sales from Target back to Meta (Conversions API, CRM events).
//   POST /capi-send   hourly. Does nothing until audit_settings.capi_enabled, capi_dataset and the META_CAPI_TOKEN secret are set.
// The phone is read from Bitrix (read-only) at send time, hashed, and never stored.
import { Any, authorized, daysAgo, json, sb, upsert } from "../_shared/sync.ts";
import { bx } from "../_shared/bitrix.ts";

const TARGET_SOURCE = "UC_EH91DG", PER_RUN = 80;
const VER = Deno.env.get("META_API_VERSION") ?? "v23.0";

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function normalPhone(raw: string) {
  const d = raw.replace(/\D/g, "");
  return d.length === 9 ? "998" + d : d.length === 12 && d.startsWith("998") ? d : null;
}

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "forbidden" }, 403);
  const token = Deno.env.get("META_CAPI_TOKEN");
  const { data: cfg } = await sb.from("audit_settings").select("capi_enabled, capi_dataset").eq("id", 1).single();
  if (!cfg?.capi_enabled || !cfg.capi_dataset || !token) return json({ ok: true, skipped: true, enabled: !!cfg?.capi_enabled, dataset: !!cfg?.capi_dataset, token: !!token });
  try {
    const since = daysAgo(7).toISOString(); // Meta rejects older events
    const [{ data: qual }, { data: sales }, { data: done }] = await Promise.all([
      sb.from("leads").select("bitrix_id, updated_at").eq("is_qual", true).eq("source_id", TARGET_SOURCE).gte("updated_at", since).limit(1000),
      sb.from("v_sale_events").select("lead_id, sold_at, amount").gte("sold_at", since).not("lead_id", "is", null).limit(1000),
      sb.from("capi_events").select("lead_id, event, sent_at, error").or("sent_at.not.is.null,error.eq.no phone"),
    ]);
    const seen = new Set((done ?? []).map((r: Any) => `${r.event}:${r.lead_id}`));
    const ids = [...new Set((sales ?? []).map((r: Any) => r.lead_id))];
    const { data: targets } = ids.length ? await sb.from("leads").select("bitrix_id").eq("source_id", TARGET_SOURCE).in("bitrix_id", ids) : { data: [] };
    const isTarget = new Set((targets ?? []).map((r: Any) => r.bitrix_id));
    const todo: Any[] = [
      ...(sales ?? []).filter((r: Any) => isTarget.has(r.lead_id)).map((r: Any) => ({ lead: r.lead_id, event: "Purchase", time: r.sold_at, value: +r.amount || 0 })),
      ...(qual ?? []).map((r: Any) => ({ lead: r.bitrix_id, event: "QualifiedLead", time: r.updated_at })),
    ].filter((x) => !seen.has(`${x.event}:${x.lead}`)).slice(0, PER_RUN);

    const results: Any[] = [], data: Any[] = [], batch: Any[] = [];
    for (const x of todo) {
      const lead = (await bx("crm.lead.get", { id: x.lead })).result;
      const phone = normalPhone(String(lead?.PHONE?.[0]?.VALUE ?? ""));
      if (!phone) { results.push({ lead_id: x.lead, event: x.event, error: "no phone", sent_at: null }); continue; }
      batch.push(x);
      data.push({
        event_name: x.event, event_time: Math.floor(Date.parse(x.time) / 1000), event_id: `${x.event}-${x.lead}`, action_source: "system_generated",
        user_data: { ph: [await sha256(phone)] },
        custom_data: { event_source: "crm", lead_event_source: "Bitrix24", ...(x.event === "Purchase" ? { currency: "UZS", value: x.value } : {}) },
      });
    }
    let meta: Any = null;
    if (data.length) {
      const res = await fetch(`https://graph.facebook.com/${VER}/${cfg.capi_dataset}/events`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data, access_token: token }), signal: AbortSignal.timeout(30000),
      });
      meta = await res.json().catch(() => ({}));
      const now = new Date().toISOString(), err = res.ok ? null : String(meta?.error?.message ?? res.status).slice(0, 300);
      for (const x of batch) results.push({ lead_id: x.lead, event: x.event, sent_at: res.ok ? now : null, error: err });
    }
    if (results.length) await upsert("capi_events", results, "lead_id,event");
    return json({ ok: true, sent: results.filter((r) => r.sent_at).length, failed: results.filter((r) => r.error).length, received: meta?.events_received });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
