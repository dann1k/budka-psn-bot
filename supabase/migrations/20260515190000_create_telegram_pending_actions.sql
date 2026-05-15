create table if not exists public.telegram_pending_actions (
  chat_id bigint not null,
  user_id bigint not null,
  action text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  primary key (chat_id, user_id),
  constraint telegram_pending_actions_action_check check (
    action in ('link', 'summary_psn', 'default', 'unlink')
  )
);

alter table public.telegram_pending_actions enable row level security;
