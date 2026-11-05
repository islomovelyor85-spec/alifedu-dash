# Robbit akademiyasi — sotuv auditi

Admin dashboard (`dash/index.html`) and its Supabase backend (`supabase/`).

- **dash/** — the whole dashboard is one static page (Tailwind + supabase-js from CDN). No build step.
  Served at https://dash.alifedu.uz (Cloudflare Pages, output directory `dash`).
- **supabase/functions/** — Edge Functions: Meta / Bitrix / call sync, AI call analysis, briefs, reports.
  Secrets (Meta token, Bitrix webhook, Gemini key, cron secret) live in Supabase → Edge Functions → Secrets, never in this repo.
- **supabase/migrations/** — initial schema. Later changes were applied to the live project directly.

The page talks to Supabase with the publishable key only; all data is behind row-level security for admins.
