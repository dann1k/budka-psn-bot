create table if not exists public.psn_auth_state (
  id text primary key default 'default',
  encrypted_access_token text not null,
  encrypted_refresh_token text not null,
  access_token_expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint psn_auth_state_singleton check (id = 'default')
);

alter table public.psn_auth_state enable row level security;
