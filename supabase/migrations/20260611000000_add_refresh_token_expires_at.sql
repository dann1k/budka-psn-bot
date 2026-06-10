-- Track the PSN refresh token's own expiry (separate from the access token).
-- Nullable so existing rows migrate cleanly; the bot treats NULL as "unknown"
-- and proactively rotates the refresh token to learn its window.
alter table public.psn_auth_state
  add column if not exists refresh_token_expires_at timestamptz;
