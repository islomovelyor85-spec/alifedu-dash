-- Heavy all-history views, cached. The project runs on the free (Nano) compute, whose CPU is throttled
-- when used hard; these five views alone cost ~45 s of CPU on every dashboard open. They describe whole
-- months of history, so they are computed once an hour per company and the dashboard reads the result.
-- The views stay as they were (reports and the AI read them directly).
create table public.cache_cohort         as select 0::int as company_id, * from public.v_cohort         with no data;
create table public.cache_cohort_src     as select 0::int as company_id, * from public.v_cohort_src     with no data;
create table public.cache_cohort_summary as select 0::int as company_id, * from public.v_cohort_summary with no data;
create table public.cache_creative_score as select 0::int as company_id, * from public.v_creative_score with no data;
create table public.cache_deal_forecast  as select 0::int as company_id, * from public.v_deal_forecast  with no data;

do $$ declare t text; begin
  foreach t in array array['cache_cohort','cache_cohort_src','cache_cohort_summary','cache_creative_score','cache_deal_forecast'] loop
    execute format('create index on public.%I (company_id)', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy company_read on public.%I for select to authenticated using (public.is_company_admin() and company_id = public.current_company())', t);
    execute format('create policy worker_all on public.%I for all to audit_worker using (true) with check (true)', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select, insert, delete on public.%I to audit_worker', t);
  end loop;
end $$;

create or replace function public.refresh_view_cache(c int) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  perform set_config('app.company', c::text, true);
  delete from cache_cohort where company_id = c;         insert into cache_cohort select c, * from v_cohort;
  delete from cache_cohort_src where company_id = c;     insert into cache_cohort_src select c, * from v_cohort_src;
  delete from cache_cohort_summary where company_id = c; insert into cache_cohort_summary select c, * from v_cohort_summary;
  delete from cache_creative_score where company_id = c; insert into cache_creative_score select c, * from v_creative_score;
  delete from cache_deal_forecast where company_id = c;  insert into cache_deal_forecast select c, * from v_deal_forecast;
end $$;
alter function public.refresh_view_cache(int) owner to audit_worker;

create or replace function public.refresh_view_cache() returns void
language plpgsql security definer set search_path to 'public' as $$
declare c int;
begin for c in select id from companies where active order by id loop perform refresh_view_cache(c); end loop; end $$;

revoke execute on function public.refresh_view_cache(int) from public, anon, authenticated;
revoke execute on function public.refresh_view_cache() from public, anon, authenticated;

-- After the hourly Bitrix (:15) and Meta (:05) syncs.
select cron.schedule('refresh-view-cache', '30 * * * *', 'select public.refresh_view_cache()');
select public.refresh_view_cache();
