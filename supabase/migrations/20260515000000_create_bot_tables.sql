create table if not exists public.linked_accounts (
  chat_id bigint not null,
  user_id bigint not null,
  username text,
  username_normalized text generated always as (lower(username)) stored,
  display_name text not null,
  psn_online_id text not null,
  psn_online_id_normalized text generated always as (lower(psn_online_id)) stored,
  linked_at timestamptz not null default now(),
  primary key (chat_id, user_id, psn_online_id)
);

create unique index if not exists linked_accounts_unique_psn
  on public.linked_accounts (chat_id, psn_online_id_normalized);

create index if not exists linked_accounts_chat_user_linked_at_idx
  on public.linked_accounts (chat_id, user_id, linked_at);

create index if not exists linked_accounts_chat_username_idx
  on public.linked_accounts (chat_id, username_normalized);

alter table public.linked_accounts enable row level security;

create table if not exists public.user_preferences (
  chat_id bigint not null,
  user_id bigint not null,
  default_psn_online_id text,
  default_psn_online_id_normalized text generated always as (lower(default_psn_online_id)) stored,
  primary key (chat_id, user_id)
);

alter table public.user_preferences enable row level security;
