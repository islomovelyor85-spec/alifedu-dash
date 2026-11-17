-- Facebook form leads that reach Bitrix through a second connection: the source is set to another
-- channel (e.g. «Najot Ta'lim orqali") and the ad id field is empty, only UTM is filled:
-- utm_source = facebook, utm_campaign = campaign name, utm_content = ad set name.
-- Since 2026-11-09 about 110 such leads were missing from Target and from every ad.
-- Here, in our copy only (Bitrix is never written):
--   * the lead is linked to its Meta ad set by campaign + ad set name;
--   * the ad inside the set is chosen by Meta's own results that day (the ad with the most results not yet
--     matched gets the lead); ad_guess = true when the set has more than one ad;
--   * the lead counts as Target; the Bitrix source is kept in source_orig.
-- Runs at the start of refresh_audit_derived (after every Bitrix sync), so a re-synced lead is matched again.
alter table public.leads
  add column if not exists ad_guess boolean not null default false,
  add column if not exists source_orig text;

create or replace function public.match_fb_leads(c int) returns int
language plpgsql security definer set search_path to 'public' as $$
declare
  target text; r record; pick text; n int := 0; cnt int;
begin
  perform set_config('app.company', c::text, true);
  select code into target from crm_map where company_id = c and kind = 'source' and value = 'Target' order by code limit 1;
  create temp table if not exists _fb_used (ad_id text, day date, n int, primary key (ad_id, day)) on commit drop;
  truncate _fb_used;
  -- leads already linked by Bitrix count as used Meta results
  insert into _fb_used select l.ad_id, (l.created_at at time zone 'Asia/Tashkent')::date, count(*)
    from leads l where l.company_id = c and l.ad_id is not null and not l.ad_guess and l.created_at > now() - interval '120 days'
    group by 1, 2;
  for r in
    select l.bitrix_id, l.source_id, l.source_orig, (l.created_at at time zone 'Asia/Tashkent')::date as day, l.utm_campaign, l.utm_content
    from leads l
    where l.company_id = c and (l.ad_id is null or l.ad_guess) and l.utm_source ilike 'facebook'
      and l.utm_campaign is not null and l.utm_content is not null and l.created_at > now() - interval '120 days'
    order by l.created_at, l.bitrix_id
  loop
    pick := null;
    select a.id, count(*) over () into pick, cnt
    from ads a
    join adsets s on s.id = a.adset_id and s.company_id = c
    join campaigns cp on cp.id = s.campaign_id and cp.company_id = c
    left join ad_daily d on d.ad_id = a.id and d.date = r.day and d.company_id = c
    left join _fb_used u on u.ad_id = a.id and u.day = r.day
    where a.company_id = c and cp.name = r.utm_campaign and s.name = r.utm_content
    order by coalesce(d.results, d.leads, 0) - coalesce(u.n, 0) desc, coalesce(d.spend, 0) desc, a.id
    limit 1;
    if pick is null then continue; end if;
    insert into _fb_used values (pick, r.day, 1) on conflict (ad_id, day) do update set n = _fb_used.n + 1;
    update leads set ad_id = pick, ad_guess = cnt > 1,
      source_orig = case when target is not null and source_id is distinct from target then coalesce(source_orig, source_id) else source_orig end,
      source_id = coalesce(target, source_id)
    where company_id = c and bitrix_id = r.bitrix_id
      and (ad_id is distinct from pick or ad_guess is distinct from (cnt > 1) or source_id is distinct from coalesce(target, source_id));
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;
alter function public.match_fb_leads(int) owner to audit_worker;
revoke execute on function public.match_fb_leads(int) from public, anon, authenticated;

-- run it first in the hourly derived refresh
create or replace function public.refresh_audit_derived(c integer)
 returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  perform set_config('app.company', c::text, true);
  perform match_fb_leads(c);
  update leads l set
    course = coalesce(case when not cp.naming_error then cp.course end, l.course),
    branch = coalesce(case when not s.naming_error then s.branch end, l.branch)
  from ads a left join campaigns cp on cp.id = a.campaign_id left join adsets s on s.id = a.adset_id
  where a.id = l.ad_id
    and (l.course is distinct from coalesce(case when not cp.naming_error then cp.course end, l.course)
      or l.branch is distinct from coalesce(case when not s.naming_error then s.branch end, l.branch));
  update deals d set won_at = w.won_at
  from deal_won_history w
  where w.deal_id = d.bitrix_id and d.is_won and d.won_at is distinct from w.won_at;
  insert into course_settings (course, company_id) select distinct course, c from leads where course is not null
  on conflict do nothing;
  update course_settings cs set qual_to_sale = x.rate, updated_at = now()
  from (
    select l.course, avg((exists (select 1 from deals d where d.lead_id = l.bitrix_id and d.is_won))::int) as rate
    from leads l
    where l.is_qual and l.created_at > now() - interval '180 days'
    group by l.course having count(*) >= 20
  ) x
  where x.course = cs.course and not cs.qual_to_sale_manual;
  perform refresh_lead_branch(c);
end $function$;
alter function public.refresh_audit_derived(integer) owner to audit_worker;

-- Bitrix every 30 minutes instead of hourly, so new form leads appear sooner next to Meta's numbers.
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'audit-sync-bitrix'), schedule := '15,45 * * * *');
