// Bitrix24 → leads + deals, incremental by DATE_MODIFY, resumable across invocations.
//   POST /sync-bitrix           hourly: from last cursor (10 min overlap)
//   POST /sync-bitrix?days=90   backfill (restarts both sources from now − 90d)
// A run that hits the time budget saves its position and re-invokes itself.
import { Any, authorized, daysAgo, getState, json, sb, setState, upsert } from "../_shared/sync.ts";
import { bx, bxPage } from "../_shared/bitrix.ts";

const BUDGET_MS = 110_000;
const COURSE_FIELD = Deno.env.get("BITRIX_COURSE_FIELD"); // optional UF_CRM_* fallback when lead has no ad
const BRANCH_FIELD = Deno.env.get("BITRIX_BRANCH_FIELD");
// Lead field filled by the Facebook lead-form integration with the Meta ad id (more reliable than UTM_CONTENT).
const AD_ID_FIELD = Deno.env.get("BITRIX_AD_ID_FIELD") ?? "UF_CRM_1760698528";
// Branch the deal was handed to ("Filialini tanlang:" list) and the branch the client typed in the lead form.
const DEAL_BRANCH_FIELD = "UF_CRM_669F92274CC6D", FORM_BRANCH_FIELD = "UF_CRM_1727904923821";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "forbidden" }, 403);
  const deadline = Date.now() + BUDGET_MS;
  const days = +(new URL(req.url).searchParams.get("days") ?? 0) || 0;
  try {
    const { data: cfg } = await sb.from("audit_settings").select("*").eq("id", 1).single();
    const qual: string[] = cfg?.qual_statuses ?? [], won: string[] = cfg?.won_stages ?? [], lost: string[] = cfg?.lost_stages ?? [];
    const now = () => new Date().toISOString();

    const leadSelect = ["ID", "STATUS_ID", "DATE_CREATE", "ASSIGNED_BY_ID", "UTM_SOURCE", "UTM_CAMPAIGN", "UTM_CONTENT", "PHONE", "SOURCE_ID", AD_ID_FIELD, FORM_BRANCH_FIELD];
    // Operator code only (998 93 xxx → "93"); the full number is never stored.
    const phoneCode = (r: Any) => {
      const d = String(r.PHONE?.[0]?.VALUE ?? "").replace(/\D/g, "");
      const local = d.length === 12 && d.startsWith("998") ? d.slice(3) : d.length === 9 ? d : null;
      return local ? local.slice(0, 2) : d ? "boshqa" : null;
    };
    if (COURSE_FIELD) leadSelect.push(COURSE_FIELD);
    if (BRANCH_FIELD) leadSelect.push(BRANCH_FIELD);
    const lead = (r: Any) => {
      const utm = (r.UTM_CONTENT ?? "").trim(), adField = String(r[AD_ID_FIELD] ?? "").trim();
      return {
        bitrix_id: +r.ID, ad_id: /^\d+$/.test(adField) ? adField : /^\d+$/.test(utm) ? utm : null,
        utm_source: r.UTM_SOURCE || null, utm_campaign: r.UTM_CAMPAIGN || null, utm_content: utm || null,
        created_at: r.DATE_CREATE, status: r.STATUS_ID, is_qual: qual.includes(r.STATUS_ID),
        manager_id: +r.ASSIGNED_BY_ID || null, phone_code: phoneCode(r), source_id: r.SOURCE_ID || null, updated_at: now(),
        form_branch: String(r[FORM_BRANCH_FIELD] ?? "").trim().slice(0, 200) || null,
        ...(COURSE_FIELD ? { course: r[COURSE_FIELD] ? String(r[COURSE_FIELD]).toUpperCase() : null } : {}),
        ...(BRANCH_FIELD ? { branch: r[BRANCH_FIELD] ? String(r[BRANCH_FIELD]).toUpperCase() : null } : {}),
      };
    };

    const branchItems = (await bx("crm.deal.fields")).result?.[DEAL_BRANCH_FIELD]?.items ?? [];
    const branchName = new Map<string, string>(branchItems.map((i: Any) => [String(i.ID), String(i.VALUE).toUpperCase()]));

    // Stage lists from settings; until filled, fall back to Bitrix stage semantics (S = won, F = lost).
    const deal = (r: Any) => {
      const isWon = won.length ? won.includes(r.STAGE_ID) : r.STAGE_SEMANTIC_ID === "S";
      const isLost = lost.length ? lost.includes(r.STAGE_ID) : r.STAGE_SEMANTIC_ID === "F";
      return {
        bitrix_id: +r.ID, lead_id: +r.LEAD_ID || null, stage: r.STAGE_ID, amount: +r.OPPORTUNITY || 0,
        created_at: r.DATE_CREATE, won_at: isWon ? (r.CLOSEDATE || r.DATE_MODIFY) : null,
        is_won: isWon, is_lost: isLost, manager_id: +r.ASSIGNED_BY_ID || null,
        paid_amount: parseFloat(String(r.UF_CRM_1690399614 ?? "").split("|")[0]) || 0,
        first_paid_at: r.UF_CRM_1742372657 || null,
        lost_reason: String(r.UF_CRM_1735389373322 || r.UF_CRM_6A8C1DE6EB661 || "") || null,
        branch: branchName.get(String(r[DEAL_BRANCH_FIELD] ?? "")) ?? null,
        updated_at: now(),
      };
    };

    const sources = [
      { source: "bitrix_leads", method: "crm.lead.list", select: leadSelect, map: lead, table: "leads" },
      {
        source: "bitrix_deals", method: "crm.deal.list", table: "deals", map: deal,
        select: ["ID", "LEAD_ID", "STAGE_ID", "STAGE_SEMANTIC_ID", "OPPORTUNITY", "DATE_CREATE", "CLOSEDATE", "DATE_MODIFY", "ASSIGNED_BY_ID",
          "UF_CRM_1690399614", "UF_CRM_1742372657", "UF_CRM_1735389373322", "UF_CRM_6A8C1DE6EB661", DEAL_BRANCH_FIELD], // paid total, first payment date, lost reasons, branch
      },
    ];

    const result: Any = {};
    let done = true;
    for (const s of sources) {
      let st: Any = await getState(s.source);
      if (days || !st.run_since) {
        const since = days ? daysAgo(days) : st.cursor ? new Date(+new Date(st.cursor) - 600_000) : daysAgo(90);
        st = { ...st, run_since: since.toISOString(), run_started: now(), last_id: 0 };
      }
      let n = 0;
      while (true) {
        const page = await bxPage(s.method, { ">=DATE_MODIFY": st.run_since }, s.select, +st.last_id);
        await upsert(s.table, page.map(s.map), "bitrix_id");
        n += page.length;
        if (page.length) st.last_id = +page[page.length - 1].ID;
        if (page.length < 50) {
          st = { ...st, cursor: st.run_started, run_since: null, run_started: null, last_id: null };
          break;
        }
        if (Date.now() > deadline) break;
        await setState(s.source, { ...st, last_run_at: now(), last_error: null });
      }
      await setState(s.source, { ...st, last_run_at: now(), last_error: null });
      result[s.table] = n;
      if (st.run_since) { done = false; break; }
    }

    // Sale dates from stage history: the first time the deal entered any sale stage (CLOSEDATE is editable and often stale).
    // merge_won_history keeps the earliest date, so a deal moving on from "To'lov qildi" to WON is not re-dated.
    if (done) {
      const hs: Any = await getState("bitrix_won_history");
      const since = hs.cursor ? new Date(+new Date(hs.cursor) - 86400_000) : daysAgo(days || 400), started = now();
      const wonStages = won.length ? won : ["C47:WON"];
      const first: Record<string, string> = {};
      let complete = true;
      for (const stage of wonStages) {
        let start: Any = 0;
        while (start !== undefined && Date.now() < deadline + 20_000) {
          const body = await bx("crm.stagehistory.list", { entityTypeId: 2, order: { ID: "ASC" }, select: ["OWNER_ID", "CREATED_TIME"], start,
            filter: { STAGE_ID: stage, ">=CREATED_TIME": since.toISOString() } });
          for (const r of body.result?.items ?? []) if (!first[r.OWNER_ID] || r.CREATED_TIME < first[r.OWNER_ID]) first[r.OWNER_ID] = r.CREATED_TIME;
          start = body.next;
        }
        if (start !== undefined) complete = false;
      }
      const rows = Object.entries(first).map(([id, t]) => ({ deal_id: +id, won_at: t }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.rpc("merge_won_history", { rows: rows.slice(i, i + 500) });
        if (error) throw new Error(`deal_won_history: ${error.message}`);
      }
      await setState("bitrix_won_history", { ...hs, ...(complete ? { cursor: started } : {}), last_run_at: started, last_error: null });
      result.won_history = rows.length;
    }

    await sb.rpc("refresh_audit_derived");
    if (!done) {
      // Continue in a fresh invocation (no ?days, so it resumes instead of restarting).
      EdgeRuntime.waitUntil(fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-bitrix`, {
        method: "POST",
        headers: { "x-cron-secret": req.headers.get("x-cron-secret")!, authorization: req.headers.get("authorization") ?? "" },
      }));
    }
    return json({ ok: true, done, ...result });
  } catch (e) {
    for (const s of ["bitrix_leads", "bitrix_deals"]) {
      const st = await getState(s).catch(() => null);
      if (st) await setState(s, { ...st, last_run_at: new Date().toISOString(), last_error: String(e) }).catch(() => {});
    }
    return json({ error: String(e) }, 500);
  }
});
