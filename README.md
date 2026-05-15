# budka-psn-bot

Telegram-бот для групповых чатов с PSN-статистикой. Runtime полностью перенесён на Supabase:

- Telegram присылает updates через webhook в Supabase Edge Function;
- постоянные данные лежат в Supabase Postgres;
- runtime-секреты хранятся в Supabase secrets;
- GitHub Actions деплоит Edge Function, Supabase secrets и Telegram webhook при каждом push в `main`;
- локальная SQLite-база больше не используется ботом, только как источник одноразовой миграции.

## Архитектура

- `supabase/functions/telegram-webhook/index.ts` — HTTP entrypoint Edge Function: `GET` health-check, `POST` Telegram webhook, остальные методы `405`.
- `supabase/functions/telegram-webhook/bot.ts` — команды Telegram и бизнес-логика.
- `supabase/functions/telegram-webhook/repository.ts` — доступ к Supabase Postgres через secret key.
- `supabase/functions/telegram-webhook/psn.ts` — PSN API, persistent auth через refresh token, summary, presence, список платин.
- `supabase/functions/telegram-webhook/psn-auth-store.ts` — зашифрованное хранение PSN access/refresh tokens в Supabase.
- `supabase/functions/telegram-webhook/format.ts` — форматирование rich messages и Telegram entities.
- `supabase/functions/telegram-webhook/emojis.ts` — tracked emoji-конфиг без runtime-чтения JSON.
- `supabase/migrations/` — схема Postgres.
- `.github/workflows/deploy-supabase.yml` — автодеплой на push в `main`.
- `scripts/migrate-sqlite-to-supabase.mjs` — одноразовый перенос старой SQLite-базы.

## Команды бота

`/start` и `/help` показывают справку. Остальные команды рассчитаны на `group` и `supergroup`.

- `/link <online-id>` — привязать PSN-аккаунт к отправителю команды.
- `/me` — показать свои PSN-аккаунты и обновить Telegram metadata.
- `/summary` — сводка по своим привязкам.
- `/summary @telegram` — сводка по привязкам участника группы.
- `/summary <psn-id>` — сводка напрямую из PSN без сохранения в базу.
- `/default <online-id>` — выбрать приоритетный аккаунт для `/summary`.
- `/region` — регионы аккаунтов отправителя.
- `/region @telegram` — регионы аккаунтов участника группы.
- `/plats` — платины отправителя по всем аккаунтам.
- `/plats @telegram` — платины участника группы.
- `/popular` — топ-5 игр по числу разных участников чата, которые в них играли.
- `/popular debug [game]` — тот же топ, плюс причины пропуска недоступных PSN-аккаунтов и поиск игровых бакетов по названию.
- `/unlink` — удалить все свои привязки в текущей группе.
- `/unlink <online-id>` — удалить одну свою привязку.
- `/table` — таблица группы по PSN.

## Supabase база данных

Актуальная схема лежит в `supabase/migrations/`. GitHub Actions не применяет миграции автоматически, чтобы не хранить пароль Postgres-базы в GitHub secrets. Перед первым деплоем или после изменения схемы нужно вручную выполнить SQL из нужных файлов в Supabase Dashboard -> SQL Editor.

- `linked_accounts` хранит связи `chat_id + user_id -> psn_online_id`.
- `user_preferences` хранит выбранный `default_psn_online_id`.
- `psn_auth_state` хранит один глобальный зашифрованный PSN auth state бота.
- `chat_id` и `user_id` — `bigint`.
- `linked_at` — `timestamptz`.
- Для case-insensitive поиска есть generated columns:
  - `psn_online_id_normalized = lower(psn_online_id)`;
  - `username_normalized = lower(username)`;
  - `default_psn_online_id_normalized = lower(default_psn_online_id)`.
- Уникальность PSN внутри группы: unique index `(chat_id, psn_online_id_normalized)`.
- RLS включён, public policies не создаются. Edge Function работает через `BUDKA_PSN_SUPABASE_SECRET_KEY`.
- Foreign keys между `user_preferences` и `linked_accounts` намеренно не добавлены, чтобы сохранить текущее поведение default-аккаунта.
- В `psn_auth_state` access/refresh tokens хранятся в формате `v1:<iv-base64>:<ciphertext-base64>` и шифруются AES-GCM ключом `BUDKA_PSN_AUTH_ENCRYPTION_KEY`.

## Секреты

Runtime secrets Supabase Edge Function:

```env
BUDKA_PSN_TELEGRAM_BOT_TOKEN=...
BUDKA_PSN_TELEGRAM_WEBHOOK_SECRET=...
BUDKA_PSN_NPSSO=...
BUDKA_PSN_SUPABASE_SECRET_KEY=...
BUDKA_PSN_AUTH_ENCRYPTION_KEY=...
```

`SUPABASE_URL` Supabase предоставляет Edge Function автоматически.

`BUDKA_PSN_SUPABASE_SECRET_KEY` — это Supabase `Secret key` из Settings -> API Keys. В новом интерфейсе он заменяет legacy `service_role` key и нужен только backend-коду.

`BUDKA_PSN_AUTH_ENCRYPTION_KEY` — base64-encoded 32-byte ключ для AES-GCM шифрования PSN токенов. Сгенерировать:

```bash
openssl rand -base64 32
```

Не использовать generic `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`: в общем Supabase project они могут принадлежать другим функциям. Для этого бота все runtime-секреты namespaced через `BUDKA_PSN_*`.

GitHub Actions secrets:

```env
SUPABASE_ACCESS_TOKEN=...
SUPABASE_PROJECT_REF=...
BUDKA_PSN_TELEGRAM_BOT_TOKEN=...
BUDKA_PSN_TELEGRAM_WEBHOOK_SECRET=...
BUDKA_PSN_NPSSO=...
BUDKA_PSN_SUPABASE_SECRET_KEY=...
BUDKA_PSN_AUTH_ENCRYPTION_KEY=...
```

`BUDKA_PSN_TELEGRAM_WEBHOOK_SECRET` передаётся в Telegram `setWebhook.secret_token`; Edge Function проверяет header `X-Telegram-Bot-Api-Secret-Token`.

Пароль Postgres-базы (`SUPABASE_DB_PASSWORD`) и connection string (`SUPABASE_DB_URL`) в GitHub secrets не нужны. Миграции базы применяются вручную через SQL Editor.

## Деплой

На каждый push в `main` workflow делает:

1. `deno check supabase/functions/telegram-webhook/index.ts`;
2. `supabase secrets set ... --project-ref "$SUPABASE_PROJECT_REF"`;
3. `supabase functions deploy telegram-webhook --project-ref "$SUPABASE_PROJECT_REF"`;
4. Telegram `setWebhook` на `https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/telegram-webhook`.

Перед первым деплоем нужно создать Supabase project и заполнить GitHub Actions secrets.

## Ручная миграция схемы

Перед первым запуском бота:

1. Открыть Supabase Dashboard -> SQL Editor.
2. Скопировать и выполнить SQL из `supabase/migrations/20260515000000_create_bot_tables.sql`.
3. Скопировать и выполнить SQL из `supabase/migrations/20260515010000_create_psn_auth_state.sql`.
4. Проверить, что появились таблицы `linked_accounts`, `user_preferences` и `psn_auth_state`.

Эти миграции идемпотентные: в них используются `if not exists`, поэтому повторный запуск не должен пересоздать таблицы.

Если таблицы `linked_accounts` и `user_preferences` уже созданы, достаточно выполнить только `20260515010000_create_psn_auth_state.sql`.

## Локальная проверка

Установить Deno и Supabase CLI.

```bash
npm run check
```

`npm run check` использует установленный `deno`, путь из `DENO_BIN` или уже скачанный локальный npm/npx cache. Он не скачивает Deno заново на каждый запуск.

Локальный запуск Edge Function:

```bash
supabase functions serve telegram-webhook --env-file supabase/functions/.env.local
```

`supabase/functions/.env.local` должен содержать runtime secrets. Не коммитить этот файл.

Health-check:

```bash
curl http://127.0.0.1:54321/functions/v1/telegram-webhook
```

## Перенос старой SQLite-базы

Скрипт читает `data/bot.sqlite` и импортирует строки в Supabase через REST/secret key.

Dry-run по умолчанию:

```bash
npm run migrate:dry-run
```

Реальный импорт:

```bash
SUPABASE_URL=https://PROJECT_REF.supabase.co \
BUDKA_PSN_SUPABASE_SECRET_KEY=... \
npm run migrate:apply
```

Опции:

```bash
node scripts/migrate-sqlite-to-supabase.mjs --sqlite=data/bot.sqlite --env-file=.env.local --apply
```

Поведение:

- если `linked_accounts` есть и не пустая, импортируется она;
- иначе используется legacy `linked_profiles`;
- `user_preferences` импортируется, если таблица есть;
- по умолчанию скрипт печатает только counts;
- `--apply` делает upsert в `linked_accounts` и `user_preferences`;
- после успешного переноса локальная SQLite-база больше не нужна runtime-боту.

## PSN auth и summary

- Первый успешный PSN auth через `BUDKA_PSN_NPSSO` сохраняет access/refresh tokens в `psn_auth_state`.
- Access/refresh tokens шифруются через `BUDKA_PSN_AUTH_ENCRYPTION_KEY`; plaintext не хранится в базе.
- Перед PSN-запросами бот использует in-memory auth cache, затем persisted auth state из Supabase.
- Access token обновляется через refresh token за 5 минут до истечения.
- Если PSN вернул auth-ошибку, бот один раз принудительно обновляет auth и повторяет исходный запрос.
- `BUDKA_PSN_NPSSO` остаётся emergency fallback, если persisted refresh token отсутствует или невалиден.
- Summary получает профиль, shareable URL, trophy summary, регион, presence, последние игры и avatar URL.
- Закрытые профили без публичных trophy-данных не привязываются.
- Presence и recent games деградируют мягко: при ошибке presence становится `offline`, последние игры — пустым списком.
- Для привязанного игрока `level` и трофеи суммируются по всем аккаунтам, `progress` берётся как максимум.
- Приоритет подробной карточки: `/default`, затем первый non-RU аккаунт, затем первый добавленный.
- `/popular` временно строится по PSN trophy titles (`getUserTitles`), чтобы видеть старые игры из trophy list. Игра группируется по `npServiceName + npCommunicationId`; один Telegram-участник считается один раз, даже если игра есть на нескольких его PSN-аккаунтах. Рейтинг сортируется по числу участников, затем по названию игры.
- В `/popular` участники выводятся без `@`, чтобы не отправлять им Telegram-уведомления; `/popular debug` дополнительно показывает до 10 пропущенных аккаунтов и краткую причину, а `/popular debug uncharted` показывает все найденные игровые бакеты по строке поиска.

## Что не коммитить

- `.env`, `.env.*`, кроме `.env.example`;
- `supabase/functions/.env`, `supabase/functions/.env.*`;
- `data/`;
- `node_modules/`;
- `dist/`.
