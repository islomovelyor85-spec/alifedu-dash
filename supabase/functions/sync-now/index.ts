// "Yangilash" button: an admin starts the Meta, Bitrix and call syncs now instead of waiting for the cron.
//   POST /sync-now   (Authorization: the admin's session) → { results: { [job]: status } }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
const JOBS = ["sync-meta", "sync-bitrix", "sync-calls"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { authorization: req.headers.get("authorization") ?? "" } }, auth: { persistSession: false },
  });
  const { data: isAdmin } = await user.rpc("is_admin");
  if (!isAdmin) return json({ error: "Faqat adminlar uchun" }, 403);

  // Each job resumes itself if it runs out of time; wait up to 55 s, then report what finished.
  const results: Record<string, string> = {};
  await Promise.all(JOBS.map(async (job) => {
    try {
      const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${job}`, {
        method: "POST", headers: { "x-cron-secret": Deno.env.get("CRON_SECRET")!, authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}` },
        signal: AbortSignal.timeout(55_000),
      });
      results[job] = r.ok ? "ok" : `xato ${r.status}`;
    } catch (e) {
      results[job] = (e as Error).name === "TimeoutError" ? "davom etmoqda" : String(e);
    }
  }));
  return json({ results });
});
