import type { MessageEntity } from "grammy/types";
import type { EmojiConfig, EmojiToken } from "./config.js";

export type RichMessage = {
  text: string;
  entities: MessageEntity[];
};

export type AccountLabel = {
  onlineId: string;
  regionCode?: string;
  hasPlus: boolean;
  status?: "playing" | "online" | "offline";
  lastOnline?: string | null;
  recentGames?: string[];
  currentGames?: string[];
};

type RichMessagePart =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "emoji"; token: EmojiToken };

function utf16Length(value: string): number {
  return [...value].reduce(
    (length, char) => length + (char.codePointAt(0)! > 0xffff ? 2 : 1),
    0
  );
}

function buildRichMessage(lines: RichMessagePart[][]): RichMessage {
  const textParts: string[] = [];
  const entities: MessageEntity[] = [];
  let offset = 0;

  lines.forEach((line, lineIndex) => {
    line.forEach((part) => {
      const value = part.type === "emoji" ? part.token.value : part.value;
      textParts.push(value);
      const length = utf16Length(value);

      if (part.type === "bold") {
        entities.push({ type: "bold", offset, length });
      }

      if (part.type === "italic") {
        entities.push({ type: "italic", offset, length });
      }

      if (part.type === "emoji" && part.token.id) {
        entities.push({
          type: "custom_emoji",
          offset,
          length,
          custom_emoji_id: part.token.id
        });
      }

      offset += length;
    });

    if (lineIndex < lines.length - 1) {
      textParts.push("\n");
      offset += 1;
    }
  });

  return {
    text: textParts.join(""),
    entities
  };
}

export function getFlagEmoji(regionCode: string | undefined): string {
  if (!regionCode || regionCode.length !== 2) {
    return "🏳️";
  }

  const code = regionCode.toUpperCase();
  const chars = [...code].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65);
  return String.fromCodePoint(...chars);
}

function buildAccountListParts(accounts: AccountLabel[], emojis: EmojiConfig): RichMessagePart[] {
  const parts: RichMessagePart[] = [];

  accounts.forEach((account, index) => {
    if (index > 0) {
      parts.push({ type: "text", value: ", " });
    }

    parts.push({ type: "text", value: account.onlineId });

    if (account.hasPlus) {
      parts.push({ type: "text", value: " " });
      parts.push({ type: "emoji", token: emojis.icons.plus });
    }

    parts.push({ type: "text", value: ` ${getFlagEmoji(account.regionCode)}` });
  });

  return parts;
}

function getStatusEmojiToken(
  status: AccountLabel["status"],
  emojis: EmojiConfig
): EmojiToken {
  if (status === "playing") {
    return emojis.icons.statusPlaying;
  }

  if (status === "online") {
    return emojis.icons.statusOnline;
  }

  return emojis.icons.statusOffline;
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function pluralizeRu(value: number, forms: [string, string, string]): string {
  const mod10 = value % 10;
  const mod100 = value % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return forms[0];
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return forms[1];
  }

  return forms[2];
}

function formatRelativeDateTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) {
    return formatDateTime(value);
  }

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (diffMs < hour) {
    const minutes = Math.max(1, Math.floor(diffMs / minute));
    return `${minutes} ${pluralizeRu(minutes, ["минуту", "минуты", "минут"])} назад`;
  }

  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return `${hours} ${pluralizeRu(hours, ["час", "часа", "часов"])} назад`;
  }

  if (diffMs < week) {
    const days = Math.floor(diffMs / day);
    return `${days} ${pluralizeRu(days, ["день", "дня", "дней"])} назад`;
  }

  if (diffMs < month) {
    const weeks = Math.floor(diffMs / week);
    return `${weeks} ${pluralizeRu(weeks, ["неделю", "недели", "недель"])} назад`;
  }

  if (diffMs < year) {
    const months = Math.floor(diffMs / month);
    return `${months} ${pluralizeRu(months, ["месяц", "месяца", "месяцев"])} назад`;
  }

  const years = Math.floor(diffMs / year);
  return `${years} ${pluralizeRu(years, ["год", "года", "лет"])} назад`;
}

export function formatSummary(input: {
  primaryAccount: AccountLabel;
  otherAccounts: AccountLabel[];
  level: number;
  progress: number;
  trophies: {
    platinum: number;
    gold: number;
    silver: number;
    bronze: number;
  };
}, emojis: EmojiConfig): RichMessage {
  const account = input.primaryAccount;
  const gameNames = account.currentGames && account.currentGames.length > 0
    ? account.currentGames
    : account.recentGames ?? [];
  const activityLine =
    account.status === "playing" && account.currentGames && account.currentGames.length > 0
      ? `В игре: ${account.currentGames.join(", ")}`
      : `Был в сети: ${formatRelativeDateTime(account.lastOnline) ?? "неизвестно"}`;
  const recentLine =
    account.status === "playing"
      ? `Последние игры: ${account.recentGames && account.recentGames.length > 0 ? account.recentGames.join(", ") : "нет данных"}`
      : `Игры: ${gameNames.length > 0 ? gameNames.join(", ") : "нет данных"}`;

  return buildRichMessage([
    [
      { type: "emoji", token: getStatusEmojiToken(account.status, emojis) },
      { type: "text", value: " " },
      { type: "bold", value: account.onlineId },
      ...(account.hasPlus
        ? [
            { type: "text", value: " " } as const,
            { type: "emoji", token: emojis.icons.plus } as const
          ]
        : []),
      { type: "text", value: ` ${getFlagEmoji(account.regionCode)}` }
    ],
    [{ type: "text", value: activityLine }],
    [{ type: "text", value: "" }],
    [{ type: "text", value: `Уровень: ${input.level} (${input.progress}%)` }],
    [
      { type: "text", value: "Трофеи: " },
      { type: "emoji", token: emojis.trophies.platinum },
      { type: "text", value: String(input.trophies.platinum) },
      { type: "text", value: " " },
      { type: "emoji", token: emojis.trophies.gold },
      { type: "text", value: String(input.trophies.gold) },
      { type: "text", value: " " },
      { type: "emoji", token: emojis.trophies.silver },
      { type: "text", value: String(input.trophies.silver) },
      { type: "text", value: " " },
      { type: "emoji", token: emojis.trophies.bronze },
      { type: "text", value: String(input.trophies.bronze) }
    ],
    [{ type: "text", value: "" }],
    [{ type: "text", value: recentLine }],
    ...(input.otherAccounts.length > 0
      ? [
          [{ type: "text", value: "" }],
          [{ type: "text", value: "Доп. аккаунты: " }, ...buildAccountListParts(input.otherAccounts, emojis)]
        ] as RichMessagePart[][]
      : [])
  ]);
}

export function formatLeaderboardRow(input: {
  telegramLabel: string;
  accounts: AccountLabel[];
  level: number;
  trophies: {
    platinum: number;
    gold: number;
    silver: number;
    bronze: number;
  };
}, emojis: EmojiConfig): RichMessage {
  const message = buildRichMessage([
    [
      { type: "text", value: input.telegramLabel },
      { type: "text", value: " " },
      { type: "bold", value: String(input.level) }
    ],
    buildAccountListParts(input.accounts, emojis),
    [
      { type: "emoji", token: emojis.trophies.platinum },
      { type: "text", value: String(input.trophies.platinum) },
      { type: "text", value: " " },
      { type: "emoji", token: emojis.trophies.gold },
      { type: "text", value: String(input.trophies.gold) },
      { type: "text", value: " " },
      { type: "emoji", token: emojis.trophies.silver },
      { type: "text", value: String(input.trophies.silver) },
      { type: "text", value: " " },
      { type: "emoji", token: emojis.trophies.bronze },
      { type: "text", value: String(input.trophies.bronze) }
    ]
  ]);

  return {
    text: message.text,
    entities: [
      ...message.entities,
      { type: "blockquote", offset: 0, length: utf16Length(message.text) }
    ]
  };
}

export function formatPlatinumRow(
  input: {
    titleName: string;
    platform: string;
    occurrences: Array<{
      regionCode?: string;
      earnedAt: string;
    }>;
  },
  emojis: EmojiConfig,
  options?: { showPlatform?: boolean; showRegions?: boolean }
): RichMessage {
  const occurrenceText = input.occurrences
    .map((occurrence) => {
      const earnedDate = new Date(occurrence.earnedAt);
      const formattedDate = Number.isNaN(earnedDate.getTime())
        ? occurrence.earnedAt
        : new Intl.DateTimeFormat("ru-RU", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric"
          }).format(earnedDate);

      if (options?.showRegions) {
        const flag = getFlagEmoji(occurrence.regionCode);
        return `${flag} ${formattedDate}`;
      }

      return formattedDate;
    })
    .join(", ");

  const parts: RichMessagePart[] = [
    { type: "emoji", token: emojis.trophies.platinum },
    { type: "text", value: ` ${input.titleName}` }
  ];

  if (options?.showPlatform) {
    parts.push({ type: "text", value: " " });
    parts.push({ type: "italic", value: `(${input.platform})` });
  }

  parts.push({ type: "text", value: " • " });
  parts.push({ type: "italic", value: occurrenceText });

  return buildRichMessage([parts]);
}
