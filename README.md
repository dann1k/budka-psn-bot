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
- `supabase/functions/telegram-webhook/texts.ts` — tracked конфиг всех текстов кнопок и ответов бота (см. ниже раздел «Тексты кнопок и ответов»).
- `supabase/functions/telegram-webhook/renderer-assets.ts` — ленивая загрузка ассетов (Inter, `resvg.wasm`, иконки трофеев, логотип PS+) из приватного бакета Supabase Storage `renderer-assets`; буферы кэшируются в памяти изолята. См. ниже раздел «Настройка Supabase Storage».
- `renderer-assets-source/` — исходные renderer assets и их лицензии. Файлы из этой папки нужно вручную загружать в бакет `renderer-assets` при обновлении. В Supabase deploy bundle папка не попадает.
- `supabase/migrations/` — схема Postgres.
- `.github/workflows/deploy-supabase.yml` — автодеплой на push в `main`.
- `scripts/migrate-sqlite-to-supabase.mjs` — одноразовый перенос старой SQLite-базы.

## Меню и команды бота

Основной вход для пользователей — `/menu`. Бот отправляет персональное inline-меню под сообщением; чужие клики по этому меню блокируются, а результаты кнопок отправляются новыми сообщениями. `/start` и `/help` показывают menu-first справку.

Команды работают и в `group`/`supergroup`, и в личке с ботом. В группе бот всегда работает с данными этой группы. В личке он показывает данные выбранного группового чата: при единственном доступном чате он выбирается автоматически, а если бот добавлен в несколько чатов — нужно один раз выбрать чат скрытой командой `/chat`. Выбор хранится по пользователю и переключается тем же `/chat`. Доступными считаются чаты, известные боту, в которых пользователь сейчас состоит (плюс чаты с его привязками).

Кнопки меню:

- `Моя сводка`, `Мои аккаунты`, `Таблица`, `Популярные`, `Платины`, `Регионы` — выполняют действие сразу для отправителя или группы.
- `Привязать PSN`, `Выбрать default`, `Summary по игроку`, `Отвязать PSN` — включают пошаговый режим и ждут следующий текст от того же пользователя в том же чате.
- Для `Summary по игроку` следующим сообщением можно прислать `@telegram` участника чата или PSN Online ID; для своей сводки есть быстрая кнопка `Моя сводка`.
- `/cancel` отменяет ожидаемый ввод PSN ID или цели summary; любая другая slash-команда тоже сбрасывает старое ожидание и выполняется как обычно.

Быстрые команды остаются доступны:

- `/menu` — открыть персональное меню.
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
- `/popular` — PNG-карточка с топ-5 игр по числу разных участников чата, которые в них играли.
- `/popular debug [game]` — тот же топ, плюс поиск игровых бакетов по названию.
- `/unlink` — удалить все свои привязки в текущей группе.
- `/unlink <online-id>` — удалить одну свою привязку.
- `/table` — таблица группы по PSN.
- `/cancel` — отменить пошаговое действие из меню.
- `/chat` — скрытая команда: только в личке, выбрать или сменить групповой чат, данные которого показывать. В групповой справке не анонсируется.

## Тексты кнопок и ответов

Все пользовательские тексты — подписи кнопок меню, ответы команд, ошибки, подсказки пошаговых действий и справка `/help` — собраны в одном файле `supabase/functions/telegram-webhook/texts.ts`. В `bot.ts` нет захардкоженных строк: код ссылается на `texts.*`.

- Статичные строки лежат как литералы, строки с подстановкой (`${...}`) — как короткие функции (например `texts.link.added(onlineId)`), а справка `/help` — функция от `{ inPrivate }`.
- Чтобы поменять формулировку или подпись кнопки, отредактируй нужное поле в `texts.ts` и сделай push в `main`. Автодеплой (`.github/workflows/deploy-supabase.yml`) пересоберёт Edge Function, и бот начнёт отдавать новый текст — отдельная миграция БД или ручная загрузка не нужны.
- `callback_data` кнопок задаётся отдельно от подписей, поэтому переименование кнопки не ломает обработчики.
- Тексты, запечённые в PNG-карточки (`renderer.tsx`), сообщения об ошибках БД (`repository.ts`) и строки относительного времени (`format.ts`) в этот конфиг не входят.

## Фич-тоглы (`config/features.json`)

Поведенческие переключатели бота живут в `config/features.json` в корне репозитория — обычный коммитимый JSON, который правится через `true`/`false`. Файл бандлится в Edge Function при сборке (через JSON-импорт в `features.ts`), поэтому новое значение «подтягивается» при следующем деплое: правишь JSON → push в `main` → автодеплой (`.github/workflows/deploy-supabase.yml`) пересобирает функцию. Рантайм-фетча нет, на каждый апдейт сетевых задержек не добавляется.

```json
{
  "deleteMenuMessages": true,
  "renderScale": {
    "summary": 1,
    "table": 1,
    "popular": 1
  }
}
```

- `renderScale` — множители разрешения PNG-карточек по типам ответа. `1` = текущее поведение (значение по умолчанию), `>1` — крупнее и чётче, `<1` — мельче и быстрее. Удобно подкручивать, когда чат растёт и карточки становятся блёклыми.
  - `summary` — сводка игрока (`/summary`, кнопка «Моя сводка», `renderGamerCard`);
  - `table` — таблица группы (`/table`, `renderLeaderboard`);
  - `popular` — популярные игры (`/popular`, `renderPopularGames`).
  - Значения зажимаются в диапазон `[0.5, 2]` (защита от опечатки вроде `10`); мусор или отсутствие ключа → `1`.
  - Как это работает: множитель масштабирует и потолок апскейла, и пиксельный бюджет рендера (см. `renderer.tsx` → `computeOutputWidth`). Таблица и популярные растут с числом участников и авто-уменьшаются под бюджет CPU — поэтому именно для них множитель и поднимает планку разрешения.
  - **⚠️ Риск CPU:** Edge Function на free-плане режет ~2с CPU на запрос. Для растущих `table`/`popular` высокие множители (грубо `>1.3` на большом чате) могут упереться в лимит — рендер падает, и Telegram ретраит вебхук. Подкручивай постепенно и смотри логи (`[leaderboard-render] scale=… outW=…`, `[popular-render]`, `[summary-render]`). Сводка — фиксированная карточка, для неё риск ниже.
- `deleteMenuMessages` — чистить «командный мусор» меню. Когда `true`:
  - сообщение с командой `/menu` удаляется сразу после показа меню;
  - само меню (сообщение «Меню:») удаляется после того, как пользователь выбрал пункт — но только если хендлер отработал без ошибки (при сбое меню остаётся, чтобы можно было повторить выбор);
  - чтобы у результатов не оставалось «цитаты на удалённое сообщение», ответы на выбранный пункт в этом режиме отправляются без reply-цитаты на меню;
  - inline-меню под `/help` и `/start` НЕ трогается: там та же клавиатура прикреплена к тексту справки, и удалять его по клику нельзя (различаем выделенное меню по тексту сообщения).
- **Важно для групп:** удалять чужие сообщения (команду `/menu` пользователя) бот может только будучи админом с правом «Удаление сообщений». Своё меню он удаляет всегда (Telegram разрешает боту стирать свои сообщения в течение 48 часов). Если прав нет — команда просто останется, остальной функционал не ломается (ошибка гасится в лог).
- Загрузка флагов (`features.ts`) валидирует типы: если ключ отсутствует или имеет неверный тип, берётся безопасное значение по умолчанию (`deleteMenuMessages: false`, все `renderScale` → `1`).

## Supabase база данных

Актуальная схема лежит в `supabase/migrations/`. GitHub Actions не применяет миграции автоматически, чтобы не хранить пароль Postgres-базы в GitHub secrets. Перед первым деплоем или после изменения схемы нужно вручную выполнить SQL из нужных файлов в Supabase Dashboard -> SQL Editor.

- `linked_accounts` хранит связи `chat_id + user_id -> psn_online_id`.
- `user_preferences` хранит выбранный `default_psn_online_id`.
- `telegram_pending_actions` хранит временное пошаговое действие меню для пары `chat_id + user_id`.
- `telegram_chats` — каталог известных боту групповых чатов (`chat_id -> title, type, last_seen_at`); заполняется на групповых апдейтах и нужен, чтобы в личке предлагать выбор чата по названию.
- `dm_chat_selections` хранит выбранный пользователем в личке групповой чат (`user_id -> chat_id`).
- `psn_auth_state` хранит один глобальный зашифрованный PSN auth state бота.
- `chat_id` и `user_id` — `bigint`.
- `linked_at` — `timestamptz`.
- Для case-insensitive поиска есть generated columns:
  - `psn_online_id_normalized = lower(psn_online_id)`;
  - `username_normalized = lower(username)`;
  - `default_psn_online_id_normalized = lower(default_psn_online_id)`.
- Уникальность PSN внутри группы: unique index `(chat_id, psn_online_id_normalized)`.
- RLS включён, public policies не создаются. Edge Function работает через `BUDKA_PSN_SUPABASE_SECRET_KEY`.
- Pending actions живут 10 минут, затем следующий ввод считается истёкшим и очищается.
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
4. Telegram `setWebhook` на `https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/telegram-webhook` с `allowed_updates: ["message", "callback_query"]`.

Перед первым деплоем нужно создать Supabase project и заполнить GitHub Actions secrets.

## Настройка Supabase Storage

Edge Function лениво подтягивает шрифты, `resvg.wasm`, PNG-иконки трофеев и логотип PS+ из приватного бакета Supabase Storage. Функция ходит туда с `service_role` ключом, который Supabase сам инжектит в env Edge Function как `SUPABASE_SERVICE_ROLE_KEY` (этот ключ обходит RLS, отдельные политики на `storage.objects` не нужны). Без бакета функция стартует с ошибкой `Failed to fetch renderer asset ...`.

1. Supabase Dashboard -> Storage -> `New bucket`.
2. Name: `renderer-assets`, флажок `Public bucket` **выключен**, остальные настройки по умолчанию.
3. Открыть SQL Editor и выполнить `supabase/migrations/20260519230000_renderer_assets_storage_policy.sql` — миграция фиксирует приватный флаг бакета и удаляет старую публичную RLS-политику, если она вдруг осталась. Идемпотентна, можно запускать повторно.
4. Внутри созданного бакета загрузить файлы из локальной папки `renderer-assets-source/` (можно перетаскиванием):
   - `resvg.wasm`
   - `Inter-Regular.ttf`
   - `Inter-Bold.ttf`
   - `trophy-platinum.png`
   - `trophy-gold.png`
   - `trophy-silver.png`
   - `trophy-bronze.png`
   - `playstation-plus.png`
5. Проверить доступ из терминала: `curl -I -H "Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>" "https://<SUPABASE_PROJECT_REF>.supabase.co/storage/v1/object/renderer-assets/resvg.wasm"` — должен вернуть `HTTP/2 200`. Без заголовка тот же URL должен возвращать `400/404` — это и есть закрытый доступ.

При обновлении шрифтов, wasm или иконок: положить новую версию в `renderer-assets-source/` (для истории и лицензий) и перезалить тот же файл в бакет с тем же именем. Имена в бакете строго совпадают с именами файлов в `renderer-assets-source/`.

`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` Supabase подставляет в Edge Functions автоматически — дополнительных секретов в GitHub Actions добавлять не нужно.

## Ручная миграция схемы

Перед первым запуском бота:

1. Открыть Supabase Dashboard -> SQL Editor.
2. Скопировать и выполнить SQL из `supabase/migrations/20260515000000_create_bot_tables.sql`.
3. Скопировать и выполнить SQL из `supabase/migrations/20260515010000_create_psn_auth_state.sql`.
4. Скопировать и выполнить SQL из `supabase/migrations/20260515190000_create_telegram_pending_actions.sql`.
5. Проверить, что появились таблицы `linked_accounts`, `user_preferences`, `psn_auth_state` и `telegram_pending_actions`.

Эти миграции идемпотентные: в них используются `if not exists`, поэтому повторный запуск не должен пересоздать таблицы.

Если таблицы `linked_accounts`, `user_preferences` и `psn_auth_state` уже созданы, достаточно выполнить только `20260515190000_create_telegram_pending_actions.sql`.

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

Получить временный PSN access token для ручного curl-дебага:

```bash
npm run psn:token -- --env-file=supabase/functions/.env.local --print-token
```

Скрипт использует `BUDKA_PSN_NPSSO`, печатает срок жизни токена и выводит access token только с явным флагом `--print-token`.

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

- Первый успешный PSN auth через `BUDKA_PSN_NPSSO` сохраняет access/refresh tokens в `psn_auth_state`. Дальше NPSSO нужен только как bootstrap/аварийный fallback — в штатном режиме бот живёт на ротации refresh token.
- Access/refresh tokens шифруются через `BUDKA_PSN_AUTH_ENCRYPTION_KEY`; plaintext не хранится в базе.
- Перед PSN-запросами бот использует in-memory auth cache, затем persisted auth state из Supabase.
- Access token (~1 час) обновляется через refresh token за 5 минут до истечения. Каждая успешная ротация выдаёт новый refresh token и сбрасывает его ~60-дневный срок — так цепочка живёт бесконечно.
- `refresh_token_expires_at` хранит срок жизни самого refresh token. Если до него осталось < 7 дней (или он неизвестен), бот ротирует refresh token проактивно, даже когда access token ещё свежий.
- Запрос токена всегда проверяет HTTP-статус ответа PSN и различает ошибки: `invalid_grant` (refresh token мёртв → только тогда возможен NPSSO bootstrap) против transient (сеть/5xx/429/битый ответ → ретраи с backoff, NPSSO **не** трогается). Это и был root cause старого падения: vendored `psn-api` не проверял `res.ok`, любой сбой ротации молча уводил бота на NPSSO, а тот успевал протухнуть.
- `PsnAuthStore.save` жёстко валидирует state перед записью — пустые/`NaN` токены никогда не перезапишут рабочий refresh token.
- Конкурентные запросы внутри одного isolate схлопываются в один refresh (single-flight); гонку ротации (`invalid_grant` из-за того, что соседний isolate уже обновил токен) бот переживает, перечитав state, без обращения к NPSSO.
- Если PSN вернул auth-ошибку на самом API-запросе, бот один раз принудительно обновляет auth и повторяет исходный запрос.

### Keep-alive (бот живёт вечно даже без трафика)

Refresh token живёт ~60 дней и продлевается только при ротации. Чтобы простаивающий чат не дал ему протухнуть, есть keep-alive: scheduled job дёргает Edge Function, а та ротирует refresh token.

- Endpoint: любой запрос к функции с заголовком `x-budka-keepalive: <BUDKA_PSN_TELEGRAM_WEBHOOK_SECRET>` запускает `ensureFreshAuthorization()` (ротация non-destructive: при transient-сбое старый токен остаётся на месте).
- Расписание через Supabase Cron (pg_cron + pg_net): см. [`supabase/keepalive-cron.sql`](supabase/keepalive-cron.sql) — запусти один раз в SQL Editor (или собери job в Dashboard → Integrations → Cron). Рекомендуемая частота — ежедневно: огромный запас против 60-дневного окна.

### Если бот всё-таки умер (NPSSO протух)

1. Применить миграции к проду (новая колонка `refresh_token_expires_at`): `supabase db push` (или прогнать `supabase/migrations/20260611000000_add_refresh_token_expires_at.sql` в SQL Editor). **Сделать это до деплоя нового кода.**
2. Получить свежий NPSSO: открыть https://ca.account.sony.com/api/v1/ssocookie (залогинившись в PSN) и скопировать `npsso`. Проверить локально: `npm run psn:token -- --env-file=supabase/functions/.env.local`.
3. Обновить секрет `BUDKA_PSN_NPSSO` (GitHub secret + `supabase secrets set`) и задеплоить.
4. Первый же запрос (или вызов keep-alive) сделает bootstrap из нового NPSSO и сохранит свежие access/refresh tokens — дальше цепочка ротации держит бота живым сама.
- Summary получает профиль, shareable URL, trophy summary, регион, presence, последние игры и avatar URL.
- Закрытые профили без публичных trophy-данных не привязываются.
- Presence и recent games деградируют мягко: при ошибке presence становится `offline`, последние игры — пустым списком.
- Для привязанного игрока `level` и трофеи суммируются по всем аккаунтам, `progress` берётся как максимум.
- Приоритет подробной карточки: `/default`, затем первый non-RU аккаунт, затем первый добавленный.
- `/popular` временно строится по PSN trophy titles (`getUserTitles`), чтобы видеть старые игры из trophy list. Игра группируется по `npServiceName + npCommunicationId`; один Telegram-участник считается один раз, даже если игра есть на нескольких его PSN-аккаунтах. Рейтинг сортируется по числу участников, затем по названию игры.
- В обычном `/popular` участники выводятся на PNG-карточке без `@`, чтобы не отправлять им Telegram-уведомления. `/popular debug uncharted` остаётся текстовым режимом и показывает найденные игровые бакеты по строке поиска, PSN-аккаунты, из которых они пришли, resolved `accountId`, число загруженных trophy titles и проверенные аккаунты без совпадений.

## Что не коммитить

- `.env`, `.env.*`, кроме `.env.example`;
- `supabase/functions/.env`, `supabase/functions/.env.*`;
- `data/`;
- `node_modules/`;
- `dist/`.
