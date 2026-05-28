-- Private renderer-assets storage bucket used by the telegram-webhook
-- Edge Function (fonts, resvg.wasm, trophy icons). The function reads
-- objects with the service_role key, which bypasses RLS — no SELECT
-- policy on storage.objects is needed and would only widen access.
-- Idempotent: safe to re-run on existing projects.

insert into storage.buckets (id, name, public)
values ('renderer-assets', 'renderer-assets', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Public read access to renderer-assets" on storage.objects;
