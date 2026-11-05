// Bitrix telephony → call_log (every call, for speed-to-lead) and the call_review analysis queue.
// Reads Bitrix only (voximplant.statistic.get). Incremental by CALL_START_DATE, resumable.
//   POST /sync-calls            cron: from the saved cursor (10 min overlap)
//   POST /sync-calls?days=40    backfill from now − 40 days
import { Any, authorized, daysAgo, getState, json, setState, sleep, upsert } from "../_shared/sync.ts";
import { bx } from "../_shared/bitrix.ts";

const SOURCE = "bitrix_calls", BUDGET_MS = 110_000, ANALYSE_MIN_SEC = 40;

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "forbidden" }, 403);
  const deadline = Date.now() + BUDGET_MS;
  const days = +(new URL(req.url).searchParams.get("days") ?? 0) || 0;
  try {
    const st = await getState(SOURCE);
    let cursor = days ? daysAgo(days).toISOString()
      : new Date(new Date(st.cursor ?? daysAgo(3)).getTime() - 10 * 60_000).toISOString();
    let total = 0, queued = 0;
    while (Date.now() < deadline) {
      const r = await bx("voximplant.statistic.get", {
        FILTER: { ">=CALL_START_DATE": cursor }, SORT: "CALL_START_DATE", ORDER: "ASC",
      });
      const rows: Any[] = r.result ?? [];
      if (!rows.length) break;
      const log = rows.map((c) => ({
        call_id: String(c.CALL_ID ?? c.ID), call_start: c.CALL_START_DATE, duration: +c.CALL_DURATION || 0,
        failed_code: c.CALL_FAILED_CODE ?? null, direction: +c.CALL_TYPE === 1 ? "chiquvchi" : "kiruvchi",
        operator_id: +c.PORTAL_USER_ID || null,
        lead_id: c.CRM_ENTITY_TYPE === "LEAD" ? +c.CRM_ENTITY_ID || null : null,
        deal_id: c.CRM_ENTITY_TYPE === "DEAL" ? +c.CRM_ENTITY_ID || null : null,
        record_file_id: +c.RECORD_FILE_ID || null,
      }));
      await upsert("call_log", log, "call_id");
      // Answered calls with a recording go to the AI analysis queue (basic fields only).
      const toAnalyse = log.filter((c) => c.failed_code === "200" && c.duration >= ANALYSE_MIN_SEC && c.record_file_id)
        .map(({ failed_code: _f, ...c }) => c);
      if (toAnalyse.length) await upsert("call_review", toAnalyse, "call_id");
      total += log.length; queued += toAnalyse.length;
      const last = rows[rows.length - 1].CALL_START_DATE;
      if (rows.length < 50 || last === cursor) { cursor = last; break; }
      cursor = last; // next page starts at the last seen timestamp (upsert makes the overlap harmless)
      await sleep(500);
    }
    await setState(SOURCE, { cursor, last_run_at: new Date().toISOString(), last_error: null });
    return json({ ok: true, calls: total, queued, cursor });
  } catch (e) {
    await setState(SOURCE, { last_run_at: new Date().toISOString(), last_error: String(e).slice(0, 500) }).catch(() => {});
    return json({ error: String(e) }, 500);
  }
});
