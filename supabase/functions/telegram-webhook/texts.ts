import type { PendingTelegramAction } from "./repository.ts";

// Единый конфиг всех текстов кнопок и ответов бота. Здесь можно править любые
// формулировки и подписи кнопок, не трогая логику в bot.ts. После push в main
// авто-деплой (.github/workflows/deploy-supabase.yml) пересобирает функцию, и
// бот начинает отдавать новые тексты. Статичные строки — литералы; строки с
// подстановкой — функции; справка /help — функция от { inPrivate }.
export const texts = {
  // Подписи кнопок главного меню (buildActionMenu) и заголовок при его показе.
  menu: {
    summary: "Моя сводка",
    me: "Мои аккаунты",
    table: "Таблица лидеров",
    popular: "Популярные игры",
    plats: "Мои платины",
    region: "Регионы",
    default: "Выбрать аккаунт по умолчанию",
    summaryPsn: "Найти игрока",
    link: "Привязать PSN",
    unlink: "Отвязать PSN",
    close: "Закрыть",
    header: "Меню:"
  },

  // Ожидаемый ввод после кнопки меню (link/summary_psn/default/unlink).
  pending: {
    labels: {
      link: "Привязать PSN",
      summary_psn: "Получить информацию по игроку или ник PSN",
      default: "Выбрать default",
      unlink: "Отвязать PSN"
    } as Record<PendingTelegramAction, string>,
    hints: {
      link: "Пришли ник в PSN, который нужно привязать.",
      summary_psn:
        "Пришли @telegram участника чата или ник в PSN. Для своей сводки можно просто нажать «Моя сводка».",
      default: "Пришли ник в PSN из твоих привязок, который сделать default.",
      unlink: "Пришли ник в PSN для удаления или /cancel, если передумал."
    } as Record<PendingTelegramAction, string>,
    footer: "Отмена: /cancel",
    summaryWho: (mention: string) => `${mention}, кого ищем?`,
    summaryPlaceholder: "Введите ник @Telegram или ник PSN",
    cancelled: "Ок, отменил ожидаемое действие.",
    expired: "Ожидаемое действие истекло. Открой /menu и попробуй ещё раз.",
    hintCleared: "Сбросил подсказку ввода."
  },

  // Общие строки, переиспользуемые в нескольких командах.
  common: {
    unknownActor: "Не удалось определить отправителя команды.",
    unknownSender: "Не удалось определить отправителя.",
    unsupportedChat: "Бот работает в группах и в личке.",
    photoUnavailable: "Интерфейс отправки фото недоступен.",
    noProfilesInGroup: "В этой группе пока нет привязанных PSN-профилей.",
    noLinks: "Сначала привяжи хотя бы один профиль через /link <online-id> или /menu.",
    playerNotFound: (arg: string) => `Не нашёл игрока ${arg} среди привязанных пользователей.`,
    noSharedChats:
      "Я пока не вижу ни одного общего с тобой чата. Добавь меня в нужный чат (или напиши там что-нибудь), потом возвращайся в личку.",
    notLinkedTo: (onlineId: string) => `У тебя нет привязки к ${onlineId}.`,
    andMore: (count: number) => `и ещё ${count}`
  },

  // Понятные сообщения об ошибках PSN (formatPsnError).
  psnError: {
    unknown: "Неизвестная ошибка.",
    someoneFallback: "этого пользователя",
    privateProfile: (who: string) => `Профиль ${who} закрыт, данные о трофеях недоступны.`,
    npssoExpired:
      "PSN NPSSO истёк и refresh token недоступен. Обнови секрет BUDKA_PSN_NPSSO (новый код: https://ca.account.sony.com/api/v1/ssocookie) и передеплой бота.",
    unknownIdFallback: "с таким ID",
    userNotFound: (who: string) => `Пользователь ${who} не найден.`
  },

  // Краткие причины пропуска аккаунта в /popular (formatPopularSkipReason).
  skipReason: {
    auth: "ошибка авторизации PSN",
    forbidden: "нет доступа или закрытая активность",
    notFound: "профиль или список игр не найден",
    temporary: "временная ошибка PSN",
    network: "ошибка сети",
    unknown: "неизвестная ошибка"
  },

  // /link и привязка профиля.
  link: {
    alreadyLinkedHere: (psnOnlineId: string, owner: string) =>
      `Профиль ${psnOnlineId} уже привязан в этой группе к ${owner}.`,
    alreadyLinkedYou: (psnOnlineId: string) => `Профиль ${psnOnlineId} уже привязан к тебе.`,
    added: (onlineId: string) => `Добавил аккаунт ${onlineId}.\n\n`,
    failed: (reason: string) => `Не получилось привязать профиль: ${reason}`,
    needArg: "Укажи PSN Online ID: /link your-online-id"
  },

  // /me — свои привязки.
  me: {
    none: "У тебя пока нет привязок. Используй /link <online-id> или /menu.",
    accounts: (list: string) => `Твои аккаунты: ${list}`
  },

  // /summary.
  summary: {
    directPsnPrefix: "Данные напрямую из PSN\n\n",
    directPsnDisplayName: "Данные из PSN",
    failed: (reason: string) => `Не получилось получить сводку: ${reason}`
  },

  // /default — приоритетный аккаунт.
  default: {
    set: (onlineId: string) => `Приоритетный аккаунт для summary: ${onlineId}`,
    needArg: "Укажи PSN Online ID: /default your-online-id"
  },

  // /region.
  region: {
    line: (label: string, regions: string) => `${label}: ${regions}`,
    failed: (reason: string) => `Не получилось получить регион: ${reason}`
  },

  // /unlink.
  unlink: {
    nothingSaved: "Для тебя в этом чате не было сохранённых привязок.",
    removedOne: (onlineId: string) => `Удалил привязку ${onlineId}.`,
    removedAll: (count: number) => `Удалил все твои привязки (${count}).`
  },

  // /plats. Заголовок собирается из частей, чтобы смещение жирного entity
  // совпадало с длиной headerPrefix.
  plats: {
    none: (label: string) => `У игрока ${label} пока нет платин.`,
    headerPrefix: "Платины ",
    headerCount: (count: number) => ` (${count}):\n`,
    failed: (reason: string) => `Не получилось получить платины: ${reason}`
  },

  // /table.
  table: {
    header: (count: number) => `Таблица группы по PSN (${count}):`,
    failedFallback: "Не удалось получить данные части профилей.",
    failed: (reason: string) => `Не получилось собрать таблицу: ${reason}`
  },

  // /popular. participants — формы слова для pluralizeRu (1, 2-4, 5+).
  popular: {
    header: "Популярные игры чата",
    noData: "Не получилось собрать популярные игры: доступных данных нет.",
    noGames: "Не нашёл сыгранных игр у привязанных участников.",
    renderFallback: "Не удалось отрендерить карточку.",
    failed: (reason: string) => `Не получилось собрать популярные игры: ${reason}`,
    participants: ["участник", "участника", "участников"] as [string, string, string],
    debug: {
      byGame: (search: string) => `Debug по игре: ${search}`,
      stats: (checked: number, matched: number) =>
        `Проверено аккаунтов: ${checked}, с совпадениями: ${matched}`,
      gameRow: (name: string, count: number, participantsWord: string, players: string) =>
        `- ${name} — ${count} ${participantsWord}: ${players}`,
      accountsRow: (accounts: string) => `  аккаунты: ${accounts}`,
      noMatches: "Совпадений не найдено.",
      accountsWithoutMatch: "Проверенные аккаунты без совпадений:",
      accountRow: (account: string) => `- ${account}`,
      more: (count: number) => `...и ещё ${count}`
    }
  },

  // /chat — выбор группового чата для личной переписки.
  chat: {
    selectHeader: "Выбери чат, данные которого показывать в личке:",
    currentActive: (title: string) => `Сейчас активен чат: ${title}\nВыбери другой, если нужно:`,
    inGroup: "В группе я и так работаю с этим чатом. Команда /chat нужна только в личке.",
    titleFallback: (chatId: number) => `Чат ${chatId}`,
    selectedToast: (title: string) => `Выбран чат: ${title}`,
    activeConfirmation: (title: string) =>
      `Активный чат: ${title}\n\nМожно переключиться кнопкой ниже или открыть /menu.`,
    invalidSelect: "Не понял выбор чата.",
    otherUserSelect: "Это выбор другого пользователя. Отправь /chat"
  },

  // Короткие всплывающие ответы на нажатия кнопок (answerCallbackQuery).
  menuCallback: {
    unknownAction: "Неизвестное действие меню.",
    otherUserMenu: "Это меню другого участника. Отправь /menu",
    closed: "Меню закрыто.",
    loading: "Пожалуйста, подождите"
  },

  // /switch_mode — переключение картинка/rich. Бывший «текстовый» режим теперь
  // отдаёт Rich Messages (Bot API 10.1): таблицы, заголовки, свёрнутые блоки.
  switchMode: {
    text: "Режим ответов: ✨ rich-формат. Сводка, таблица, популярные и платины приходят таблицами и заголовками (нужен свежий Telegram).",
    image: "Режим ответов: 🖼 картинка. Сводка, таблица и популярные снова приходят картинками."
  },

  // Тексты Rich-режима (Bot API 10.1, рендерятся в rich.ts): заголовки секций,
  // подписи колонок таблиц и строки сводки. Динамические части (ники, имена игр)
  // эскейпятся в rich.ts перед подстановкой в HTML, здесь — только формулировки.
  rich: {
    leaderboard: {
      title: (count: number) => `🏆 Таблица группы · ${count}`,
      cols: { rank: "#", player: "Игрок", level: "Ур.", trophies: "Трофеи" }
    },
    popular: {
      title: "🎮 Популярные игры чата",
      cols: { rank: "#", game: "Игра", players: "Кто играет" }
    },
    summary: {
      playing: (games: string) => `Сейчас играет: ${games}`,
      lastOnlineLabel: "Был в сети",
      lastOnlineUnknown: "неизвестно",
      level: (level: number, progress: number) => `Уровень ${level} · ${progress}%`,
      games: (games: string) => `Игры: ${games}`,
      recent: (games: string) => `Последние игры: ${games}`,
      noGames: "нет данных",
      otherAccounts: (count: number) => `Доп. аккаунты (${count})`
    },
    platinum: {
      title: (label: string, count: number) => `🏆 Платины ${label} · ${count}`,
      cols: { game: "Игра", platform: "Платформа", earned: "Получена" }
    }
  },

  // /help и /start. Часть строк показывается только в личке (inPrivate).
  help: ({ inPrivate }: { inPrivate: boolean }): string =>
    [
      "Я бот для привязки участников чата к нескольким PSN-аккаунтам.",
      "",
      "Основной вход: /menu",
      "В меню есть кнопки для сводки, таблицы, популярных игр, платин, регионов и действий с PSN ID.",
      ...(inPrivate
        ? ["", "В личке я показываю данные группового чата. Выбрать или сменить чат: /chat"]
        : []),
      "",
      "Быстрые команды остаются доступны:",
      "/menu — открыть персональное меню",
      ...(inPrivate ? ["/chat — выбрать чат, данные которого смотреть в личке"] : []),
      "/link <online-id> — добавить PSN-аккаунт к себе",
      "/me — показать свои привязанные аккаунты",
      "/summary [@telegram] — суммарная сводка по игроку",
      "/summary <psn-id> — сводка напрямую из PSN",
      "/default <online-id> — выбрать приоритетный аккаунт для summary",
      "/region [@telegram] — регионы аккаунтов игрока",
      "/table — общая таблица игроков группы",
      "/plats [@telegram] — список платин игрока по всем аккаунтам",
      "/popular — топ-5 игр по числу участников чата",
      "/popular debug [game] — причины пропусков и поиск игровых бакетов",
      "/switch_mode — переключить ответы бота между картинкой и rich-форматом (таблицы)",
      "/unlink [online-id] — удалить один аккаунт или все свои привязки",
      "/cancel — отменить ввод PSN ID после кнопки меню",
      "/help — показать эту справку"
    ].join("\n")
} as const;

export type BotTexts = typeof texts;
