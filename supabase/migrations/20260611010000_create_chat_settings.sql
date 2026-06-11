-- Per-chat bot settings. response_mode toggles whether summary/table/popular
-- replies render as PNG cards ('image', default) or fall back to the legacy
-- text format ('text'), controlled by the /switch_mode command.
create table if not exists public.chat_settings (
  chat_id bigint primary key,
  response_mode text not null default 'image',
  updated_at timestamptz not null default now(),
  constraint chat_settings_response_mode_check check (response_mode in ('image', 'text'))
);

alter table public.chat_settings enable row level security;
