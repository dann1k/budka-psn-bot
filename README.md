# psn-telegram-bot

Telegram-бот для групповых чатов с привязкой одного или нескольких PSN-аккаунтов к участнику и общей статистикой по трофеям.

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

## Возможности

- хранит несколько `PSN Online ID` у одного участника группы;
- считает общие уровень и трофеи по всем привязкам;
- показывает `summary` по приоритетному аккаунту;
- строит таблицу группы;
- показывает список платин по игроку с учётом нескольких аккаунтов.

## Команды

- `/link <online-id>` — добавить PSN-аккаунт к себе.
- `/me` — показать список своих привязанных аккаунтов.
- `/summary` — показать сводку по своим привязкам.
- `/summary @telegram` — показать сводку по привязкам участника группы.
- `/summary <psn-id>` — показать сводку по конкретному PSN-аккаунту без телеграм-привязки.
- `/default <online-id>` — выбрать приоритетный аккаунт для `/summary`.
- `/table` — общая таблица игроков группы.
- `/plats` — список платин по своим привязкам.
- `/plats @telegram` — список платин по привязкам участника группы.
- `/unlink` — удалить все свои привязки.
- `/unlink <online-id>` — удалить один конкретный аккаунт.
- `/help` — показать справку.

## Логика приоритетного аккаунта

`/summary` подробно показывает только один аккаунт:

1. Если задан `/default <online-id>`, используется он.
2. Если default не задан, бот пытается выбрать не-`RU` аккаунт.
3. Если такого нет, используется первый доступный аккаунт.

По остальным аккаунтам бот выводит короткую строку `Доп. аккаунты: ...`.

## Как работает summary

В summary бот показывает:

- статус аккаунта через эмодзи;
- текущую игру, если аккаунт сейчас онлайн в игре;
- `last online` в human-readable виде;
- последние игры;
- суммарный уровень по всем аккаунтам;
- суммарные трофеи по всем аккаунтам.

## Как работает список платин

- список строится по всем привязанным аккаунтам игрока;
- одинаковые игры с разных аккаунтов схлопываются в одну запись;
- если одна и та же игра встречается в нескольких версиях, бот показывает платформу;
- если дубликат важен по регионам, рядом с датами выводятся флаги.

## Что нужно для запуска

1. Создать Telegram-бота через BotFather и получить `BOT_TOKEN`.
2. Получить `NPSSO` для PSN:
   - открыть [playstation.com](https://www.playstation.com/) и войти в аккаунт;
   - в том же браузере открыть [ca.account.sony.com/api/v1/ssocookie](https://ca.account.sony.com/api/v1/ssocookie);
   - взять значение `npsso` из JSON-ответа.
3. Скопировать `.env.example` в `.env`.
4. При необходимости настроить [`config/emojis.json`](config/emojis.json).

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

## Docker

Сборка образа:

```bash
docker build -t psn-telegram-bot .
```

Запуск контейнера:

```bash
docker run -d \
  --name psn-telegram-bot \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  psn-telegram-bot
```

Что важно:

- база SQLite хранится в `/app/data`, поэтому папку `data` лучше примонтировать volume;
- `config/emojis.json` уже включён в образ;
- если меняешь `config/emojis.json` или код, образ нужно пересобрать.

## Docker Compose

Запуск через compose:

```bash
docker compose up -d --build
```

## Деплой на сервер

```bash
git clone https://github.com/dann1k/psn-telegram-bot.git
cd psn-telegram-bot
cp .env.example .env
mkdir -p data
docker compose up -d --build
```

Обновление:

```bash
git pull
docker compose up -d --build
```

## Переменные окружения

```env
BOT_TOKEN=your_telegram_bot_token
PSN_NPSSO=your_psn_npsso
DATABASE_PATH=./data/bot.sqlite
```

## Заметки

- Один и тот же `PSN ID` нельзя привязать двум разным людям в одной группе.
- Закрытый профиль не привязывается.
- Старые одиночные привязки мигрируются в новую модель с множественными аккаунтами автоматически.
- `.env`, `data/`, `node_modules/` и `dist/` добавлены в `.gitignore` и не должны попадать в GitHub.
