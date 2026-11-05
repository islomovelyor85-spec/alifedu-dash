-- Hourly sync jobs. Needs Vault secrets (create once, values from the dashboard):
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<anon or publishable key>', 'anon_key');
--   select vault.create_secret('<same as CRON_SECRET env of the functions>', 'cron_secret');
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function call_sync(fn text, query text default '') returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/' || fn || query,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    timeout_milliseconds := 150000);
$$;
revoke execute on function call_sync(text, text) from public, anon, authenticated;

select cron.schedule('audit-sync-meta', '5 * * * *', $$select call_sync('sync-meta')$$);
select cron.schedule('audit-sync-bitrix', '15 * * * *', $$select call_sync('sync-bitrix')$$);

-- One-off 90-day backfill (run manually after secrets are set):
--   select call_sync('sync-meta', '?days=90'); select call_sync('sync-bitrix', '?days=90');
