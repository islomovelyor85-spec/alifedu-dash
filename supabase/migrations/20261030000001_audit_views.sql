-- Phase 3: metric views. security_invoker so dashboard users go through RLS (admins only).
-- Sales are attributed to the lead's week/month (cohort logic), not the sale date.

-- One won "sale" per lead: first won date, total won amount.
create or replace view v_lead_sale with (security_invoker = true) as
select lead_id, min(won_at) as won_at, sum(amount) as revenue
from deals where is_won and lead_id is not null
group by lead_id;

-- Call → lead (calls may be linked only to a deal).
create or replace view v_call_lead with (security_invoker = true) as
select c.bitrix_call_id as call_id, coalesce(c.lead_id, d.lead_id) as lead_id, c.manager_id, a.output
from calls c
left join deals d on d.bitrix_id = c.deal_id
join call_analysis a on a.call_id = c.bitrix_call_id;

-- Base: ad × week (spend by spend date, leads/sales by lead week). Leads without an ad get ad_id null.
create or replace view v_ad_week with (security_invoker = true) as
with sp as (
  select ad_id, date_trunc('week', date)::date as week, sum(spend) spend, sum(clicks) clicks, sum(leads) meta_leads
  from ad_daily group by 1, 2
), ld as (
  select l.ad_id, date_trunc('week', l.created_at)::date as week,
    max(l.course) filter (where l.ad_id is null) as course, max(l.branch) filter (where l.ad_id is null) as branch,
    count(*) leads, count(*) filter (where l.is_qual) qual_leads,
    count(s.lead_id) sales, coalesce(sum(s.revenue), 0) revenue
  from leads l left join v_lead_sale s on s.lead_id = l.bitrix_id
  group by 1, 2, case when l.ad_id is null then l.course end, case when l.ad_id is null then l.branch end
)
select coalesce(sp.week, ld.week) as week,
  coalesce(sp.ad_id, ld.ad_id) as ad_id, a.adset_id, a.campaign_id,
  coalesce(c.course, ld.course) as course, coalesce(s.branch, ld.branch) as branch,
  coalesce(sp.spend, 0) spend, coalesce(sp.clicks, 0) clicks, coalesce(sp.meta_leads, 0) meta_leads,
  coalesce(ld.leads, 0) leads, coalesce(ld.qual_leads, 0) qual_leads,
  coalesce(ld.sales, 0) sales, coalesce(ld.revenue, 0) revenue
from sp full join ld on ld.ad_id = sp.ad_id and ld.week = sp.week
left join ads a on a.id = coalesce(sp.ad_id, ld.ad_id)
left join campaigns c on c.id = a.campaign_id
left join adsets s on s.id = a.adset_id;

-- level: ad|adset|campaign|course|branch|course_branch; key = id or name at that level.
create or replace view v_funnel with (security_invoker = true) as
select week, 'ad' as level, ad_id as key, max(course) course, max(branch) branch,
  sum(spend) spend, sum(leads) leads, sum(qual_leads) qual_leads, sum(sales) sales, sum(revenue) revenue
from v_ad_week where ad_id is not null group by week, ad_id
union all
select week, 'adset', adset_id, max(course), max(branch), sum(spend), sum(leads), sum(qual_leads), sum(sales), sum(revenue)
from v_ad_week where adset_id is not null group by week, adset_id
union all
select week, 'campaign', campaign_id, max(course), null, sum(spend), sum(leads), sum(qual_leads), sum(sales), sum(revenue)
from v_ad_week where campaign_id is not null group by week, campaign_id
union all
select week, 'course', course, course, null, sum(spend), sum(leads), sum(qual_leads), sum(sales), sum(revenue)
from v_ad_week group by week, course
union all
select week, 'branch', branch, null, branch, sum(spend), sum(leads), sum(qual_leads), sum(sales), sum(revenue)
from v_ad_week group by week, branch
union all
select week, 'course_branch', coalesce(course, '?') || ' · ' || coalesce(branch, '?'), course, branch,
  sum(spend), sum(leads), sum(qual_leads), sum(sales), sum(revenue)
from v_ad_week group by week, course, branch;

create or replace view v_cpql with (security_invoker = true) as
select week, level, key, course, branch, spend, qual_leads, round(spend / nullif(qual_leads, 0), 2) as cpql
from v_funnel;

create or replace view v_cost_per_sale with (security_invoker = true) as
select week, level, key, course, branch, spend, sales, revenue,
  round(spend / nullif(sales, 0), 2) as cost_per_sale, round((revenue - spend) / nullif(spend, 0), 3) as romi
from v_funnel;

-- Cohort: lead month × months since lead.
create or replace view v_cohort with (security_invoker = true) as
with l as (
  select l.bitrix_id, l.course, l.branch, date_trunc('month', l.created_at)::date as lead_month, l.created_at, s.won_at, s.revenue
  from leads l left join v_lead_sale s on s.lead_id = l.bitrix_id
), size as (
  select lead_month, course, branch, count(*) cohort_leads,
    percentile_cont(0.5) within group (order by extract(epoch from won_at - created_at) / 86400)
      filter (where won_at is not null) as median_days_to_sale
  from l group by 1, 2, 3
), sold as (
  select lead_month, course, branch,
    ((extract(year from won_at) - extract(year from lead_month)) * 12 + extract(month from won_at) - extract(month from lead_month))::int as months_since,
    count(*) sales, sum(revenue) revenue
  from l where won_at is not null group by 1, 2, 3, 4
)
select z.lead_month, z.course, z.branch, z.cohort_leads, s.months_since,
  coalesce(s.sales, 0) sales, coalesce(s.revenue, 0) revenue,
  round(100.0 * coalesce(s.sales, 0) / z.cohort_leads, 1) as pct_of_cohort,
  round(z.median_days_to_sale::numeric, 1) as median_days_to_sale
from size z left join sold s
  on s.lead_month = z.lead_month and s.course is not distinct from z.course and s.branch is not distinct from z.branch;

-- Creative score: early = qual rate & CPQL (leads ≥14 days old), final = sales within 45 days (leads ≥45 days old).
create or replace view v_creative_score with (security_invoker = true) as
with l as (
  select l.ad_id, l.created_at, l.is_qual,
    s.won_at is not null and s.won_at <= l.created_at + interval '45 days' as sold45
  from leads l left join v_lead_sale s on s.lead_id = l.bitrix_id where l.ad_id is not null
), agg as (
  select ad_id,
    count(*) filter (where created_at <= now() - interval '14 days') leads14,
    count(*) filter (where created_at <= now() - interval '14 days' and is_qual) qual14,
    count(*) filter (where created_at <= now() - interval '45 days') leads45,
    count(*) filter (where created_at <= now() - interval '45 days' and sold45) sales45
  from l group by ad_id
), sp as (
  select ad_id, sum(spend) spend,
    sum(spend) filter (where date <= current_date - 14) spend14,
    sum(spend) filter (where date <= current_date - 45) spend45
  from ad_daily group by ad_id
)
select a.id as ad_id, a.name, a.status, a.naming_error, c.course, s.branch, a.type, a.offer, a.creative_no,
  coalesce(sp.spend, 0) spend, coalesce(g.leads14, 0) leads14, coalesce(g.qual14, 0) qual14,
  round(g.qual14::numeric / nullif(g.leads14, 0), 3) as qual_rate14,
  round(sp.spend14 / nullif(g.qual14, 0), 2) as cpql14,
  coalesce(g.leads45, 0) leads45, coalesce(g.sales45, 0) sales45,
  round(sp.spend45 / nullif(g.sales45, 0), 2) as cost_per_sale45,
  cs.max_cpql,
  -- >1 = better than target. Final (sales) score once ≥20 mature leads, else early (CPQL) score.
  round(case when g.leads45 >= 20 and sp.spend45 > 0
    then g.sales45 * cs.avg_check * cs.ad_share / sp.spend45
    else cs.max_cpql / nullif(sp.spend14 / nullif(g.qual14, 0), 0) end, 2) as score,
  (g.leads45 >= 20) as score_is_final
from ads a
left join campaigns c on c.id = a.campaign_id
left join adsets s on s.id = a.adset_id
left join course_settings cs on cs.course = c.course
left join agg g on g.ad_id = a.id
left join sp on sp.ad_id = a.id;

create or replace view v_pain_conversion with (security_invoker = true) as
select p->>'code' as pain_code, l.course, l.ad_id,
  count(*) mentions, count(distinct cl.lead_id) leads,
  count(distinct cl.lead_id) filter (where s.lead_id is not null) sold_leads,
  round(count(distinct cl.lead_id) filter (where s.lead_id is not null)::numeric / nullif(count(distinct cl.lead_id), 0), 3) as sale_rate,
  (array_agg(p->>'quote') filter (where coalesce(p->>'quote', '') <> ''))[1:3] as sample_quotes
from v_call_lead cl
cross join lateral jsonb_array_elements(coalesce(cl.output->'pains', '[]')) p
left join leads l on l.bitrix_id = cl.lead_id
left join v_lead_sale s on s.lead_id = cl.lead_id
group by 1, 2, 3;

-- Lost deals by the objection from the deal's latest analysed call.
create or replace view v_objections with (security_invoker = true) as
with last_call as (
  select distinct on (coalesce(c.deal_id, 0), coalesce(c.lead_id, 0)) c.deal_id, c.lead_id, a.output->>'objection' as objection,
    a.output->>'price_sensitivity' as price_sensitivity
  from calls c join call_analysis a on a.call_id = c.bitrix_call_id
  order by coalesce(c.deal_id, 0), coalesce(c.lead_id, 0), c.created_at desc
)
select coalesce(lc.objection, 'unknown') as objection, l.course, l.branch, count(*) lost_deals,
  count(*) filter (where lc.price_sensitivity = 'high') high_price_sensitivity
from deals d
left join leads l on l.bitrix_id = d.lead_id
left join last_call lc on lc.deal_id = d.bitrix_id or (lc.deal_id is null and lc.lead_id = d.lead_id)
where d.is_lost
group by 1, 2, 3;

create or replace view v_managers with (security_invoker = true) as
with ld as (
  select l.manager_id, count(*) leads, count(*) filter (where l.is_qual) qual_leads, count(s.lead_id) sales
  from leads l left join v_lead_sale s on s.lead_id = l.bitrix_id group by 1
), sc as (
  select manager_id, count(*) analysed_calls,
    avg((output->'manager_score'->>'needs')::numeric) needs,
    avg((output->'manager_score'->>'value')::numeric) value,
    avg((output->'manager_score'->>'objection_handling')::numeric) objection_handling,
    avg((output->'manager_score'->>'next_step')::numeric) next_step
  from v_call_lead group by 1
)
select coalesce(ld.manager_id, sc.manager_id) manager_id, coalesce(ld.leads, 0) leads, coalesce(ld.qual_leads, 0) qual_leads,
  coalesce(ld.sales, 0) sales, round(ld.sales::numeric / nullif(ld.qual_leads, 0), 3) as qual_to_sale,
  coalesce(sc.analysed_calls, 0) analysed_calls,
  round(sc.needs, 2) needs, round(sc.value, 2) value, round(sc.objection_handling, 2) objection_handling, round(sc.next_step, 2) next_step,
  round((sc.needs + sc.value + sc.objection_handling + sc.next_step) / 4, 2) as avg_score,
  (select k from (values ('needs', sc.needs), ('value', sc.value), ('objection_handling', sc.objection_handling), ('next_step', sc.next_step)) v(k, x)
   where x is not null order by x limit 1) as weakest_step
from ld full join sc on sc.manager_id = ld.manager_id;

-- Dashboard access: admins (existing is_admin()) read everything; may edit settings and brief status.
do $$ declare t text; begin
  foreach t in array array['audit_settings','course_settings','campaigns','adsets','ads','ad_daily','leads','deals',
    'calls','call_analysis','pain_taxonomy','briefs','approvals','sync_state'] loop
    execute format('drop policy if exists admin_read on %I', t);
    execute format('create policy admin_read on %I for select to authenticated using (is_admin())', t);
  end loop;
end $$;
drop policy if exists admin_write on audit_settings;
create policy admin_write on audit_settings for update to authenticated using (is_admin()) with check (is_admin());
drop policy if exists admin_write on course_settings;
create policy admin_write on course_settings for update to authenticated using (is_admin()) with check (is_admin());
drop policy if exists admin_write on briefs;
create policy admin_write on briefs for update to authenticated using (is_admin()) with check (is_admin());
