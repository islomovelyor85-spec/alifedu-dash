-- Daily Target plan per branch (leads and qualified leads per day), as in the team's plan/fact sheet.
alter table public.plan_months add column if not exists branch_daily jsonb not null default '{}'::jsonb;

-- November 2026 from the sheet (Лист1 = leads, Sifatli = qualified). Branch shares follow the same split.
update public.plan_months set
  branch_daily = '{"XADRA":{"leads":33,"qual":8},"ANDIJON":{"leads":25,"qual":6},"FARG''ONA":{"leads":50,"qual":12},"NAMANGAN":{"leads":25,"qual":6},"URGANCH":{"leads":17,"qual":4},"NAVOIY":{"leads":17,"qual":4},"TERMIZ":{"leads":17,"qual":4},"NUKUS":{"leads":8,"qual":2},"QARSHI":{"leads":25,"qual":6},"SAMARQAND":{"leads":33,"qual":8},"SIRDARYO":{"leads":8,"qual":2},"CHIMBOY":{"leads":8,"qual":2}}'::jsonb,
  branches = '{"XADRA":13,"ANDIJON":10,"FARG''ONA":19,"NAMANGAN":9,"URGANCH":6,"NAVOIY":6,"TERMIZ":6,"NUKUS":3,"QARSHI":9,"SAMARQAND":13,"SIRDARYO":3,"CHIMBOY":3}'::jsonb,
  updated_at = now()
where company_id = 1 and month = '2026-11-01';
