-- Какой групповой чат показывать пользователю в личке с ботом. Ключ — user_id
-- (в приватном чате он же chat_id личной переписки). Команда /chat и
-- авто-выбор единственного доступного чата пишут сюда выбранный chat_id.
create table if not exists public.dm_chat_selections (
  user_id bigint primary key,
  chat_id bigint not null,
  selected_at timestamptz not null default now()
);

alter table public.dm_chat_selections enable row level security;
