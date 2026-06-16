-- ============================================================================
-- DEPRECATED — only for the Supabase Edge deployment (rollback path).
-- The bot now self-hosts on a VPS and rotates the PSN token in-process
-- (server/main.ts: ensureFreshAuthorization() on boot + daily), so this pg_cron
-- job is no longer needed. If it is still scheduled, unschedule it:
--   select cron.unschedule('budka-psn-keepalive');
-- ============================================================================
-- PSN keep-alive cron (Supabase pg_cron + pg_net)
-- ============================================================================
-- Purpose: rotate the PSN refresh token DAILY so the bot lives forever even with
-- zero user traffic. Each successful rotation resets the refresh token's ~60 day
-- lifetime, so a daily cadence leaves huge margin (a week+ of PSN/network outage
-- still can't let the token lapse). NPSSO then stays a one-time bootstrap only.
--
-- This is NOT a normal auto-applied migration: it needs project-specific values
-- and a Vault secret, so run it ONCE by hand against the project database
-- (Supabase Dashboard -> SQL Editor, or psql). Re-running cron.schedule with the
-- same job name overwrites the schedule, so it is safe to re-run.
--
-- Prefer the Dashboard? Supabase -> Integrations -> Cron -> Create job ->
-- type "Edge Function" -> telegram-webhook -> method POST -> add header
-- `x-budka-keepalive: <BUDKA_PSN_TELEGRAM_WEBHOOK_SECRET>` -> schedule "0 3 * * *".
-- That wires pg_cron/pg_net/Vault for you and you can skip the SQL below.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1) Store the keep-alive secret in Vault. Use the SAME value as the deployed
--    BUDKA_PSN_TELEGRAM_WEBHOOK_SECRET (the endpoint authenticates with it).
--    Replace <WEBHOOK_SECRET> below. Run this block only once.
select vault.create_secret('<WEBHOOK_SECRET>', 'budka_psn_keepalive_secret');
-- To rotate it later instead of creating:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'budka_psn_keepalive_secret'),
--     '<NEW_WEBHOOK_SECRET>'
--   );

-- 2) Schedule the daily rotation (03:00 UTC). The project ref is the linked
--    "Pet Projects" project (xaludajhgvsjchotjrhd).
select cron.schedule(
  'budka-psn-keepalive',
  '0 3 * * *',
  $$
  select net.http_post(
    url := 'https://xaludajhgvsjchotjrhd.supabase.co/functions/v1/telegram-webhook',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-budka-keepalive', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'budka_psn_keepalive_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Inspect / verify:
--   select jobid, schedule, jobname, active from cron.job where jobname = 'budka-psn-keepalive';
--   select * from cron.job_run_details where jobid = (
--     select jobid from cron.job where jobname = 'budka-psn-keepalive'
--   ) order by start_time desc limit 5;
-- Remove if needed:
--   select cron.unschedule('budka-psn-keepalive');
