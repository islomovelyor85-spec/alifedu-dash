-- Plan built from groups, as in the team's calculator sheet:
-- groups × students per group → students (sales) ÷ visit→sale ÷ qualified→visit ÷ lead→qualified → leads × CPL → budget; daily = ÷ work days.
alter table public.plan_months
  add column if not exists branch_groups jsonb not null default '{}'::jsonb,
  add column if not exists per_group int not null default 14,
  add column if not exists work_days int not null default 27;

update public.plan_months set
  branch_groups = '{"ANDIJON":3,"NAVOIY":2,"FARG''ONA":6,"XADRA":4,"SAMARQAND":4,"NAMANGAN":3,"QARSHI":3,"CHIMBOY":1,"NUKUS":1,"SIRDARYO":1,"TERMIZ":2,"URGANCH":2}'::jsonb,
  per_group = 14, work_days = 27,
  sales = 448, lead_qual = 0.25, qual_came = 0.5, came_sale = 0.5, cpl = 3,
  channels = '{"Target":100}'::jsonb,
  updated_at = now()
where company_id = 1 and month = '2026-11-01';
