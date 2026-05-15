# budka-psn-bot

Telegram-бот для групповых чатов: связывает участников с одним или несколькими PSN-аккаунтами, показывает сводки по трофеям, таблицу группы, регионы аккаунтов и список платин.

README описывает фактическую реализацию бота и служит памяткой для возвращения к разработке.

## Быстрый старт

```bash
cp .env.example .env
npm install
npm run dev
```

Для Docker:

```bash
docker compose up -d --build
```

## Что умеет бот

- хранит несколько `PSN Online ID` у одного Telegram-пользователя в рамках группы;
- не даёт привязать один и тот же PSN ID двум разным людям в одной группе;
- показывает summary по своим привязкам, по `@telegram` или по прямому PSN ID;
- суммирует уровень и трофеи по всем привязкам игрока;
- строит таблицу группы по уровню и весу трофеев;
- показывает регионы аккаунтов;
- показывает список платин по всем аккаунтам игрока;
- использует кастомные Telegram emoji из `config/emojis.json`, если для них заданы `custom_emoji_id`.

## Команды

`/start` и `/help` показывают встроенную справку. Остальные команды рассчитаны на `group` и `supergroup`; в личке бот отвечает, что команда работает только в группах.

- `/link <online-id>` — привязать PSN-аккаунт к отправителю команды. Перед сохранением бот проверяет, что профиль существует, данные о трофеях публичны, и PSN ID ещё не занят другим участником этой группы. В базу сохраняется канонический `onlineId`, который возвращает PSN.
- `/me` — показать PSN-аккаунты отправителя в текущей группе и обновить сохранённые `username`/`displayName` пользователя.
- `/summary` — показать сводку по привязкам отправителя.
- `/summary @telegram` — показать сводку по привязкам найденного участника группы. Поиск работает по сохранённому Telegram username без учета регистра.
- `/summary <psn-id>` — получить сводку напрямую из PSN без Telegram-привязки. Если у профиля есть avatar URL, ответ отправляется фото с caption.
- `/default <online-id>` — выбрать приоритетный аккаунт для `/summary`. Значение должно совпадать с одной из привязок отправителя.
- `/region` — показать регионы всех аккаунтов отправителя.
- `/region @telegram` — показать регионы всех аккаунтов найденного участника группы.
- `/plats` — показать список платин отправителя по всем его PSN-аккаунтам.
- `/plats @telegram` — показать список платин найденного участника группы.
- `/unlink` — удалить все привязки отправителя в текущей группе и его запись в `user_preferences`.
- `/unlink <online-id>` — удалить одну привязку отправителя; если она была default-аккаунтом, default сбрасывается.
- `/table` — собрать общую таблицу группы по всем сохранённым пользователям.

Важно: встроенный `/help` сейчас короче README и не упоминает `/region` и прямой `/summary <psn-id>`.

## Summary и агрегация аккаунтов

Для привязанного игрока бот загружает summary по всем его аккаунтам параллельно и собирает общий профиль:

- `level` считается как сумма уровней всех аккаунтов;
- трофеи считаются как сумма platinum/gold/silver/bronze по всем аккаунтам;
- `progress` берётся как максимальный progress среди аккаунтов;
- список аккаунтов показывает PSN ID, PS Plus, регион-флаг и статус;
- подробная карточка показывается только по одному аккаунту, остальные уходят в строку `Доп. аккаунты: ...`.

Приоритет подробной карточки:

1. аккаунт, выбранный через `/default <online-id>`;
2. первый аккаунт с регионом не `RU`;
3. первый добавленный аккаунт.

В summary показываются статус, текущая игра или относительное `Был в сети`, уровень/progress, трофеи, последние игры и дополнительные аккаунты. Если аккаунт сейчас играет, строка активности становится `В игре: ...`, а ниже отдельно показываются последние игры.

## Таблица группы

`/table` берёт всех пользователей из `linked_accounts`, загружает их PSN summary и сортирует:

1. по суммарному `level` по убыванию;
2. при равном уровне по весу трофеев: platinum `* 1000`, gold `* 100`, silver `* 10`, bronze `* 1`.

Каждая строка содержит display name Telegram-пользователя, суммарный уровень, список аккаунтов и суммарные трофеи. Длинные ответы режутся на сообщения примерно до `3500` UTF-16 символов.

## Платины

`/plats` загружает title list по всем аккаунтам игрока и оставляет игры, где `earnedTrophies.platinum > 0`.

- группировка идёт по `titleName + platform`;
- внутри группы хранятся даты получения и регион аккаунта;
- список сортируется по самой свежей дате получения платины в группе;
- платформа показывается, если одинаковое название встречается на нескольких платформах;
- флаги у дат показываются, если у одной группы несколько occurrences;
- если платин нет, бот отвечает отдельным сообщением.

## PSN-интеграция

PSN-запросы находятся в `src/psn.ts` и используют пакет `psn-api`.

- Для авторизации нужен `PSN_NPSSO`.
- `NPSSO` обменивается на access/refresh tokens; токены кэшируются только в памяти процесса.
- Если access token ещё жив, бот переиспользует его.
- Если есть refresh token, бот сначала пробует обновить access token через него.
- Если refresh не сработал, бот заново обменивает `NPSSO`.

Для summary бот получает:

- профиль по Online ID;
- shareable profile URL;
- trophy profile summary;
- регион через `getUserRegion` с языками `ru` и `en`;
- presence через `getBasicPresence`;
- последние игры через `getUserPlayedGames` с лимитом `3`;
- avatar URL из первого элемента `profile.avatarUrls`.

Если в trophy summary нет публичных данных, бот считает профиль закрытым и не сохраняет такую привязку. Presence и recent games деградируют мягко: при ошибке presence становится `offline`, `lastOnline` — `null`, а последние игры — пустым списком.

## SQLite база данных

База открывается через `node:sqlite` (`DatabaseSync`) в `src/db.ts`.

- Путь по умолчанию: `./data/bot.sqlite`.
- В Docker данные должны жить в volume `/app/data`.
- При старте создаётся директория для базы.
- Включается `PRAGMA journal_mode = WAL`, поэтому рядом с базой могут появляться `bot.sqlite-wal` и `bot.sqlite-shm`.

Актуальные таблицы:

```sql
CREATE TABLE IF NOT EXISTS linked_accounts (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  display_name TEXT NOT NULL,
  psn_online_id TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, user_id, psn_online_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS linked_accounts_unique_psn
ON linked_accounts (chat_id, lower(psn_online_id));

CREATE TABLE IF NOT EXISTS user_preferences (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  default_psn_online_id TEXT,
  PRIMARY KEY (chat_id, user_id)
);
```

Поведение хранилища:

- `linked_accounts` хранит связи Telegram-пользователь -> PSN-аккаунты внутри конкретного `chat_id`;
- уникальный индекс запрещает две привязки одного PSN ID в одной группе без учета регистра;
- `user_preferences.default_psn_online_id` хранит выбранный default для summary;
- foreign keys между `user_preferences` и `linked_accounts` сейчас не заданы;
- удаление всех привязок пользователя удаляет и его `user_preferences`;
- удаление одного аккаунта сбрасывает default только если default указывал на этот аккаунт.

Legacy-миграция:

- если существует старая таблица `linked_profiles`, бот копирует строки в `linked_accounts`;
- копирование происходит только если `linked_accounts` ещё пустая;
- `linked_profiles` после миграции не удаляется автоматически.

## Конфигурация и emoji

Что нужно для запуска:

1. Создать Telegram-бота через BotFather и получить `BOT_TOKEN`.
2. Получить `NPSSO` для PSN:
   - открыть [playstation.com](https://www.playstation.com/) и войти в аккаунт;
   - в том же браузере открыть [ca.account.sony.com/api/v1/ssocookie](https://ca.account.sony.com/api/v1/ssocookie);
   - взять значение `npsso` из JSON-ответа.
3. Скопировать `.env.example` в `.env`.
4. При необходимости настроить [`config/emojis.json`](config/emojis.json).

Переменные окружения:

```env
BOT_TOKEN=your_telegram_bot_token
PSN_NPSSO=your_psn_npsso
DATABASE_PATH=./data/bot.sqlite
```

- `BOT_TOKEN` и `PSN_NPSSO` обязательны.
- `DATABASE_PATH` опционален, по умолчанию `./data/bot.sqlite`.
- `config/emojis.json` опционален: если файла нет или отдельных значений не хватает, используются дефолтные emoji из `src/config.ts`.
- Emoji можно задавать строкой или объектом `{ "value": "...", "id": "custom_emoji_id" }`.

## Локальный запуск

```bash
npm install
npm run dev
```

Production:

```bash
npm run build
npm start
```

Проверка типов:

```bash
npm run check
```

## Docker

Сборка образа:

```bash
docker build -t budka-psn-bot .
```

Запуск контейнера:

```bash
docker run -d \
  --name budka-psn-bot \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  budka-psn-bot
```

Что важно:

- база SQLite хранится в `/app/data`, поэтому папку `data` нужно примонтировать volume;
- `config/emojis.json` включается в образ;
- если меняешь `config/emojis.json` или код, образ нужно пересобрать.

## Docker Compose

Запуск через compose:

```bash
docker compose up -d --build
```

## Деплой на сервер

```bash
git clone https://github.com/dann1k/budka-psn-bot.git
cd budka-psn-bot
cp .env.example .env
mkdir -p data
docker compose up -d --build
```

Обновление:

```bash
git pull
docker compose up -d --build
```

## Для возвращения к разработке

Главные файлы:

- `src/index.ts` — команды Telegram, выбор пользователя, агрегация аккаунтов, сортировка таблицы;
- `src/db.ts` — SQLite-схема, миграция legacy `linked_profiles`, операции с привязками и default-аккаунтом;
- `src/psn.ts` — PSN-авторизация, summary, presence, recent games, список платин;
- `src/format.ts` — форматирование rich messages, emoji entities, summary/table/plats;
- `src/config.ts` — env-переменные и загрузка `config/emojis.json`.

Перед пушем:

```bash
npm run check
```

Не коммитить данные и секреты:

- `.env`, `.env.*`, кроме `.env.example`;
- `data/`;
- `node_modules/`;
- `dist/`.

## Заметки и ограничения

- Бот хранит привязки отдельно для каждой Telegram-группы (`chat_id`).
- Закрытые PSN-профили без публичных trophy-данных не привязываются.
- Данные PSN не кэшируются в SQLite: при командах summary/table/plats бот заново обращается к PSN API.
- Если один из PSN-запросов для `/table` или привязанного `/summary` падает, команда может целиком завершиться ошибкой.
- Локальная папка `data/` игнорируется git и может содержать реальные пользовательские данные.
