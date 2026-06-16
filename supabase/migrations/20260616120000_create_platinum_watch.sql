-- Детектор новых платин: фоновый «сторож» (server/main.ts → platinum-watcher.ts)
-- периодически опрашивает все залинкованные PSN-аккаунты и постит уведомление в
-- чат(ы), где аккаунт привязан, когда у него появляется новая платина.
--
-- Состояние опроса по каждому PSN-аккаунту (ключ — нормализованный online id,
-- как в linked_accounts). accountId кэшируем, чтобы в установившемся режиме
-- пропускать резолв профиля. disabled_until — бэк-офф для приватных/падающих.
create table if not exists public.psn_platinum_watch (
  psn_online_id_normalized text primary key,
  account_id text,
  baselined_at timestamptz,
  last_polled_at timestamptz,
  last_activity_at timestamptz,
  consecutive_errors integer not null default 0,
  disabled_until timestamptz
);

alter table public.psn_platinum_watch enable row level security;

-- Ledger «видели платину»: одна строка на (аккаунт, игра). announced_at = null —
-- платина ждёт отправки; засев baseline пишет строки сразу с announced_at = now()
-- (исторические платины НЕ анонсируем). Идемпотентность анонса — на этом штампе.
create table if not exists public.psn_platinum_seen (
  psn_online_id_normalized text not null,
  np_communication_id text not null,
  np_service_name text,
  title_name text not null,
  platform text,
  icon_url text,
  earned_at timestamptz,
  first_seen_at timestamptz not null default now(),
  announced_at timestamptz,
  primary key (psn_online_id_normalized, np_communication_id)
);

create index if not exists psn_platinum_seen_pending_idx
  on public.psn_platinum_seen (announced_at)
  where announced_at is null;

alter table public.psn_platinum_seen enable row level security;

-- Per-chat opt-out: по умолчанию анонс платин включён.
alter table public.chat_settings
  add column if not exists announce_platinums boolean not null default true;
