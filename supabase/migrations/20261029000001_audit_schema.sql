-- Phase 1: Target + Sales Audit schema. `settings` is taken by the Telegram bot,
-- so audit config lives in audit_settings (singleton) + course_settings.

create table if not exists audit_settings (
  id int primary key default 1 check (id = 1),
  qual_statuses text[] not null default '{}',
  won_stages text[] not null default '{}',
  lost_stages text[] not null default '{}',
  min_call_seconds int not null default 30,
  updated_at timestamptz not null default now()
);
insert into audit_settings (id) values (1) on conflict do nothing;

create table if not exists course_settings (
  course text primary key,
  avg_check numeric not null default 0,
  ad_share numeric not null default 0.25,
  qual_to_sale numeric not null default 0.2,    -- auto-computed unless qual_to_sale_manual
  qual_to_sale_manual boolean not null default false,
  max_cpql numeric generated always as (avg_check * ad_share * qual_to_sale) stored,
  updated_at timestamptz not null default now()
);

create table if not exists campaigns (
  id text primary key,
  name text not null,
  course text, goal text,
  naming_error boolean not null default false,
  status text,
  updated_at timestamptz not null default now()
);

create table if not exists adsets (
  id text primary key,
  campaign_id text references campaigns(id),
  name text not null,
  branch text, audience text,
  naming_error boolean not null default false,
  status text,
  updated_at timestamptz not null default now()
);

create table if not exists ads (
  id text primary key,
  adset_id text references adsets(id),
  campaign_id text references campaigns(id),
  name text not null,
  creative_no int, type text, offer text, version int,
  naming_error boolean not null default false,
  status text,
  updated_at timestamptz not null default now()
);

create table if not exists ad_daily (
  ad_id text not null references ads(id),
  date date not null,
  spend numeric not null default 0,
  impressions int not null default 0,
  clicks int not null default 0,
  leads int not null default 0,
  primary key (ad_id, date)
);

create table if not exists leads (
  bitrix_id bigint primary key,
  ad_id text,                       -- from UTM_CONTENT; not FK: ad may sync later or be non-Meta
  utm_source text, utm_campaign text, utm_content text,
  course text, branch text,
  created_at timestamptz not null,
  status text,
  is_qual boolean not null default false,
  manager_id bigint,
  updated_at timestamptz not null default now()
);
create index if not exists leads_ad_idx on leads (ad_id);
create index if not exists leads_created_idx on leads (created_at);

create table if not exists deals (
  bitrix_id bigint primary key,
  lead_id bigint,
  stage text,
  amount numeric not null default 0,
  created_at timestamptz not null,
  won_at timestamptz,
  is_won boolean not null default false,
  is_lost boolean not null default false,
  manager_id bigint,
  updated_at timestamptz not null default now()
);
create index if not exists deals_lead_idx on deals (lead_id);

create table if not exists calls (
  bitrix_call_id text primary key,
  lead_id bigint, deal_id bigint, manager_id bigint,
  duration int,
  audio_path text,
  transcript jsonb,
  status text not null default 'new',   -- new|downloaded|transcribed|analysed|skipped|error
  created_at timestamptz not null default now()
);

create table if not exists call_analysis (
  call_id text primary key references calls(bitrix_call_id),
  output jsonb not null,
  model text not null,
  created_at timestamptz not null default now()
);

create table if not exists pain_taxonomy (
  code text primary key,
  label_uz text not null,
  examples text[] not null default '{}'
);

create table if not exists briefs (
  id bigint generated always as identity primary key,
  week date not null,
  course text not null,
  pain_code text references pain_taxonomy(code),
  offer_type text,
  hook text, script text,
  status text not null default 'draft' check (status in ('draft','approved','rejected')),
  created_at timestamptz not null default now()
);

create table if not exists approvals (
  id bigint generated always as identity primary key,
  entity text not null, action text not null,
  payload jsonb not null default '{}',
  approved_by text, approved_at timestamptz,
  created_at timestamptz not null default now()
);

-- Sync cursors + run log (idempotent incremental sync).
create table if not exists sync_state (
  source text primary key,           -- meta|bitrix_leads|bitrix_deals
  cursor timestamptz,               -- synced through this time
  run_since timestamptz, run_started timestamptz, last_id bigint,  -- in-progress run (resumable)
  last_run_at timestamptz,
  last_error text
);

-- Service role only; dashboard access policies come in Phase 4.
do $$ declare t text; begin
  foreach t in array array['audit_settings','course_settings','campaigns','adsets','ads','ad_daily','leads','deals',
    'calls','call_analysis','pain_taxonomy','briefs','approvals','sync_state'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Fill lead course/branch from the attributed ad (keeps CRM-field values when no ad),
-- then auto-compute qual_to_sale per course (last 180 days, ≥20 qual leads, not manual).
create or replace function refresh_audit_derived() returns void language sql security definer set search_path = public as $$
  update leads l set course = c.course, branch = s.branch
  from ads a join campaigns c on c.id = a.campaign_id join adsets s on s.id = a.adset_id
  where a.id = l.ad_id and not c.naming_error and not s.naming_error
    and (l.course is distinct from c.course or l.branch is distinct from s.branch);

  insert into course_settings (course) select distinct course from leads where course is not null
  on conflict do nothing;

  update course_settings cs set qual_to_sale = x.rate, updated_at = now()
  from (
    select l.course, avg((exists (select 1 from deals d where d.lead_id = l.bitrix_id and d.is_won))::int) as rate
    from leads l
    where l.is_qual and l.created_at > now() - interval '180 days'
    group by l.course having count(*) >= 20
  ) x
  where x.course = cs.course and not cs.qual_to_sale_manual;
$$;
revoke execute on function refresh_audit_derived() from public, anon, authenticated;
