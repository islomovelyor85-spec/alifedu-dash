// Meta Marketing API (env META_TOKEN, META_AD_ACCOUNT_ID, optional META_API_VERSION).
import { Any, sleep } from "./sync.ts";

const VER = Deno.env.get("META_API_VERSION") ?? "v23.0";

// GET a Graph path (e.g. "act_123/insights", "me/adaccounts") with paging; returns all rows of `data`.
export async function metaAll(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ ...params, access_token: Deno.env.get("META_TOKEN") ?? "" });
  let url: string | null = `https://graph.facebook.com/${VER}/${path}?${qs}`;
  const rows: Any[] = [];
  for (let tries = 0; url;) {
    const res: Response = await fetch(url);
    const body = await res.json();
    if (body.error) {
      // 4/17/613 = rate limit: wait and retry the same page.
      if ([4, 17, 613].includes(body.error.code) && ++tries < 4) { await sleep(30_000); continue; }
      throw new Error(`meta ${path}: ${body.error.message}`);
    }
    rows.push(...(body.data ?? []));
    url = body.paging?.next ?? null;
  }
  return rows;
}

// Ad accounts to sync: META_AD_ACCOUNT_ID (comma-separated) plus every account the token can read.
export async function adAccounts(): Promise<{ id: string; currency: string }[]> {
  const env = (Deno.env.get("META_AD_ACCOUNT_ID") ?? "").split(",").map((s) => s.trim().replace(/^act_/, "")).filter(Boolean);
  const mine = await metaAll("me/adaccounts", { fields: "account_id,currency", limit: "100" }).catch(() => []);
  const by = new Map<string, string>(mine.map((a: Any) => [String(a.account_id), a.currency]));
  for (const id of env) if (!by.has(id)) by.set(id, "");
  return [...by].map(([id, currency]) => ({ id, currency }));
}

// Lead count from insights `actions`: prefer the aggregated "lead" action type.
export function leadCount(actions: Any[] | undefined) {
  const by = Object.fromEntries((actions ?? []).map((a: Any) => [a.action_type, +a.value || 0]));
  return by["lead"] ?? (by["onsite_conversion.lead_grouped"] ?? 0) + (by["offsite_conversion.fb_pixel_lead"] ?? 0);
}

// Ads Manager "Results": the action the ad set optimises for (insights `optimization_goal`).
// Lead-form goals count form leads only; the plain "lead" action also adds the pixel lead fired for the same person.
const RESULT_ACTION: Record<string, string> = {
  LEAD_GENERATION: "onsite_conversion.lead_grouped",
  QUALITY_LEAD: "onsite_conversion.lead_grouped",
  CONVERSATIONS: "onsite_conversion.messaging_conversation_started_7d",
  LINK_CLICKS: "link_click",
  LANDING_PAGE_VIEWS: "landing_page_view",
  POST_ENGAGEMENT: "post_engagement",
  OFFSITE_CONVERSIONS: "offsite_conversion.fb_pixel_lead",
};
export function resultCount(goal: string | undefined, actions: Any[] | undefined) {
  const type = RESULT_ACTION[goal ?? ""];
  if (!type) return null;
  return +((actions ?? []).find((a: Any) => a.action_type === type)?.value ?? 0) || 0;
}

// Rate of 1 unit of `ccy` in UZS: Central Bank of Uzbekistan, falling back to open.er-api.com.
export async function cbuRate(ccy: string): Promise<{ rate: number; date: string } | null> {
  const today = new Date().toISOString().slice(0, 10);
  if (!ccy || ccy === "UZS") return { rate: 1, date: today };
  const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(8000) }).then((r) => r.ok ? r.json() : null).catch(() => null);
  const row = (await get(`https://cbu.uz/uz/arkhiv-kursov-valyut/json/${ccy}/`))?.[0];
  if (row?.Rate) {
    const [d, m, y] = String(row.Date).split(".");
    return { rate: parseFloat(row.Rate), date: `${y}-${m}-${d}` };
  }
  const er = await get(`https://open.er-api.com/v6/latest/${ccy}`);
  return er?.rates?.UZS ? { rate: er.rates.UZS, date: today } : null;
}
