// Shared helpers for sync jobs: service client, cron auth, batched upsert, sync_state.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// deno-lint-ignore no-explicit-any
export type Any = any;

export const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

export const json = (d: Any, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

// Jobs are triggered by pg_cron with x-cron-secret; anything else is rejected.
export const authorized = (req: Request) => {
  const s = Deno.env.get("CRON_SECRET");
  return !!s && req.headers.get("x-cron-secret") === s;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function upsert(table: string, rows: Any[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

export async function getState(source: string) {
  const { data } = await sb.from("sync_state").select("*").eq("source", source).maybeSingle();
  return data ?? { source };
}

export async function setState(source: string, patch: Any) {
  const { error } = await sb.from("sync_state").upsert({ source, ...patch });
  if (error) throw new Error(`sync_state: ${error.message}`);
}

export const daysAgo = (n: number) => new Date(Date.now() - n * 864e5);
