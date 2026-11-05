// Meta → campaigns/adsets/ads (names parsed by convention) + ad_daily insights, for every readable ad account.
//   POST /sync-meta                      hourly: re-pulls last 3 days (Meta restates recent numbers)
//   POST /sync-meta?days=90[&account=ID] backfill (one account per call keeps it under the time limit)
// Spend stays in the account currency; the CBU rate to UZS is stored in audit_settings.
// Each insights chunk is saved as soon as it is fetched, so a timeout loses at most one chunk.
import { Any, authorized, daysAgo, json, sb, setState, upsert } from "../_shared/sync.ts";
import { adAccounts, cbuRate, leadCount, metaAll, resultCount } from "../_shared/meta.ts";
import { parseAd, parseAdset, parseCampaign } from "../_shared/naming.ts";

const day = (d: Date) => d.toISOString().slice(0, 10);
const CHUNK_DAYS = 15;

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "forbidden" }, 403);
  const params = new URL(req.url).searchParams;
  const days = Math.min(+(params.get("days") ?? 3) || 3, 400);
  const only = params.get("account")?.replace(/^act_/, "");
  try {
    const now = new Date();
    let accounts = await adAccounts();
    if (only) accounts = accounts.filter((a) => a.id === only);
    if (!accounts.length) throw new Error("no ad accounts: set META_AD_ACCOUNT_ID or give the token ad account access");

    // Currency first: all accounts are expected to share one; the dashboard converts at the CBU rate.
    const ccy = accounts.find((a) => a.currency)?.currency ?? "";
    // A rate the admin typed in Settings (fx_manual) wins over the Central Bank rate.
    const fx = await cbuRate(ccy);
    const { data: cfg } = await sb.from("audit_settings").select("fx_manual").eq("id", 1).maybeSingle();
    if (ccy) await sb.from("audit_settings").update({ ad_currency: ccy, ...(fx && !cfg?.fx_manual ? { fx_rate: fx.rate, fx_date: fx.date } : {}) }).eq("id", 1);

    let adCount = 0, dailyCount = 0;
    for (const acc of accounts) {
      const act = `act_${acc.id}`;
      const campaigns = new Map<string, Any>(), adsets = new Map<string, Any>(), ads = new Map<string, Any>();
      const put = (c: Any, s: Any, a: Any, status: Any, thumb?: string) => {
        const t = new Date().toISOString();
        campaigns.set(c.id, { id: c.id, account_id: acc.id, name: c.name, ...parseCampaign(c.name), status: status.c, updated_at: t });
        adsets.set(s.id, { id: s.id, campaign_id: c.id, name: s.name, ...parseAdset(s.name), status: status.s, updated_at: t });
        ads.set(a.id, { id: a.id, account_id: acc.id, adset_id: s.id, campaign_id: c.id, name: a.name, ...parseAd(a.name, s.name), status: status.a, ...(thumb ? { thumb } : {}), updated_at: t });
      };
      const flush = async (daily: Any[]) => {
        await upsert("campaigns", [...campaigns.values()], "id");
        await upsert("adsets", [...adsets.values()], "id");
        await upsert("ads", [...ads.values()], "id");
        await upsert("ad_daily", daily, "ad_id,date");
        adCount += ads.size; dailyCount += daily.length;
        campaigns.clear(); adsets.clear(); ads.clear();
      };

      // Daily insights in chunks; ads seen only here are archived/deleted (not returned by /ads).
      for (let from = daysAgo(days); from <= now; from = new Date(+from + CHUNK_DAYS * 864e5)) {
        const to = new Date(Math.min(+from + (CHUNK_DAYS - 1) * 864e5, +now));
        const rows = await metaAll(`${act}/insights`, {
          level: "ad",
          time_increment: "1",
          fields: "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,actions,optimization_goal",
          time_range: JSON.stringify({ since: day(from), until: day(to) }),
          limit: "500",
        });
        const daily: Any[] = [];
        for (const r of rows) {
          const archived = { c: "ARCHIVED", s: "ARCHIVED", a: "ARCHIVED" };
          put({ id: r.campaign_id, name: r.campaign_name }, { id: r.adset_id, name: r.adset_name }, { id: r.ad_id, name: r.ad_name }, archived);
          daily.push({
            ad_id: r.ad_id, date: r.date_start, spend: +r.spend || 0,
            impressions: +r.impressions || 0, clicks: +r.clicks || 0, leads: leadCount(r.actions), results: resultCount(r.optimization_goal, r.actions),
          });
        }
        await flush(daily);
      }

      // Live entities overwrite names/status (also brings ads with no spend yet).
      const live = await metaAll(`${act}/ads`, {
        fields: "id,name,effective_status,adset{id,name,effective_status},campaign{id,name,effective_status},creative{thumbnail_url,image_url}",
        thumbnail_width: "160", thumbnail_height: "160",
        limit: "500",
      });
      for (const a of live) {
        put(a.campaign, a.adset, a, { c: a.campaign.effective_status, s: a.adset.effective_status, a: a.effective_status }, a.creative?.image_url || a.creative?.thumbnail_url);
      }
      await flush([]);
    }

    await sb.rpc("refresh_audit_derived");
    await setState("meta", { cursor: now.toISOString(), last_run_at: now.toISOString(), last_error: null });
    return json({ ok: true, days, accounts: accounts.map((a) => a.id), currency: ccy, fx: fx?.rate, ads: adCount, daily: dailyCount });
  } catch (e) {
    await setState("meta", { last_run_at: new Date().toISOString(), last_error: String(e) }).catch(() => {});
    return json({ error: String(e) }, 500);
  }
});
