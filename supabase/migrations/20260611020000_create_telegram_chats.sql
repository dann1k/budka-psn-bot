-- Каталог чатов, где бот видел активность. Нужен, чтобы в личке предложить
-- пользователю выбор чата, данные которого показывать (см. dm_chat_selections).
-- Заполняется при каждом групповом апдейте: title обновляется, last_seen_at
-- сдвигается. Личные чаты сюда не пишутся.
create table if not exists public.telegram_chats (
  chat_id bigint primary key,
  title text,
  type text not null,
  last_seen_at timestamptz not null default now()
);

alter table public.telegram_chats enable row level security;
