-- ============================================================
-- Schedules the daily run. Run this ONCE in the Supabase SQL
-- editor AFTER the carry-daily-update edge function is deployed.
--
-- Replace the two placeholders below:
--   YOUR_PROJECT_REF  e.g. whuuytqvucbtzsraxgfh
--   YOUR_ANON_KEY     Settings -> API -> anon/publishable key
--
-- 21:00 UTC = 3:00 pm Central (daylight) / 2:00 pm (standard),
-- comfortably after the 1:20 pm CT grain settlement. Weekend
-- runs are harmless no-ops (prices upsert on the same trade date).
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('carry-daily-update')
 where exists (select 1 from cron.job where jobname = 'carry-daily-update');

select cron.schedule(
  'carry-daily-update',
  '0 21 * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/carry-daily-update?action=run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_ANON_KEY'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
