// "Yangilash" button: an admin starts the Bitrix, call and Meta syncs now instead of waiting for the cron.
//   POST /sync-now   (Authorization: the admin's session) → { results: { [job]: status } }
// The button waits only for Bitrix and calls (usually 5–20 s). Meta takes ~25 s and its numbers change
// slowly, so it keeps running in the background and the hourly sync covers it anyway.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
const WAIT = ["sync-bitrix", "sync-calls"], BACKGROUND = ["sync-meta"];
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { authorization: req.headers.get("authorization") ?? "" } }, auth: { persistSession: false },
  });
  const { data: isAdmin } = await user.rpc("is_company_admin");
  const { data: C } = await user.rpc("current_company");
  if (!isAdmin || !C) return json({ error: "Faqat adminlar uchun" }, 403);

  const run = (job: string, ms: number) => fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${job}?company=${C}`, {
    method: "POST", headers: { "x-cron-secret": Deno.env.get("CRON_SECRET")!, authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}` },
    signal: AbortSignal.timeout(ms),
  });
  for (const job of BACKGROUND) EdgeRuntime.waitUntil(run(job, 140_000).catch(() => null));

  // Each job resumes itself if it runs out of time; wait up to 40 s, then report what finished.
  const results: Record<string, string> = { "sync-meta": "fonda" };
  await Promise.all(WAIT.map(async (job) => {
    try {
      const r = await run(job, 40_000);
      results[job] = r.ok ? "ok" : `xato ${r.status}`;
    } catch (e) {
      results[job] = (e as Error).name === "TimeoutError" ? "davom etmoqda" : String(e);
    }
  }));
  return json({ results });
});
