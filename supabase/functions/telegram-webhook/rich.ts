// Rich Messages (Telegram Bot API 10.1) — строители HTML и транспорт.
//
// В отличие от format.ts (там собираются text + entities со смещениями), здесь мы
// генерируем обычные HTML-строки и отдаём их методу sendRichMessage: Telegram сам
// парсит разметку в блоки (таблицы, заголовки, свёрнутые details, кастом-эмодзи,
// живое время). HTML выбран вместо Markdown намеренно — в HTML эскейпить нужно лишь
// `& < > "`, а у игр/ников бывают `| * _ # [ ]`, которые ломали бы Markdown-таблицы.
//
// Метода sendRichMessage ещё нет в типах grammy 1.41.1, поэтому транспорт идёт через
// api.raw с единственным локальным кастом (см. sendRichMessage ниже). format.ts при
// этом остаётся нетронутым и служит fallback'ом, если Rich-отправка не удалась.
import type { Api } from "npm:grammy@1.41.1/web";
import type { InlineKeyboardMarkup, Message } from "npm:grammy@1.41.1/types";
import { getFlagEmoji, type AccountLabel } from "./format.ts";
import { texts } from "./texts.ts";
import type { EmojiConfig, EmojiToken } from "./types.ts";
// Только типы — на рантайме импорт стирается, поэтому цикла bot.ts ⇄ rich.ts нет
// (значение зависит лишь в одну сторону: bot.ts → rich.ts).
import type { AggregatedPlayer, PopularGameAccumulator } from "./bot.ts";

type TrophyCounts = { platinum: number; gold: number; silver: number; bronze: number };
type Align = "left" | "center" | "right";

const MEDALS = ["🥇", "🥈", "🥉"];

// --- Низкоуровневые помощники -------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Кастом-эмодзи: <tg-emoji emoji-id="…">fallback</tg-emoji>. Без id (например PSN)
// деградируем к обычному глифу — как guard в format.ts.
export function customEmoji(token: EmojiToken): string {
  if (!token.id) {
    return token.value;
  }

  return `<tg-emoji emoji-id="${token.id}">${token.value}</tg-emoji>`;
}

// Ячейки уже содержат готовый HTML (вызывающий обязан сам эскейпить динамику и
// прогонять эмодзи через customEmoji). Заголовки — статические подписи из texts.
function richTable(headers: string[], aligns: Align[], rows: string[][]): string {
  const head = headers
    .map((header, index) => `<th align="${aligns[index] ?? "left"}">${header}</th>`)
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, index) => `<td align="${aligns[index] ?? "left"}">${cell}</td>`)
          .join("")}</tr>`
    )
    .join("");

  return `<table><tr>${head}</tr>${body}</table>`;
}

function trophyLine(trophies: TrophyCounts, emojis: EmojiConfig): string {
  return [
    `${customEmoji(emojis.trophies.platinum)}${trophies.platinum}`,
    `${customEmoji(emojis.trophies.gold)}${trophies.gold}`,
    `${customEmoji(emojis.trophies.silver)}${trophies.silver}`,
    `${customEmoji(emojis.trophies.bronze)}${trophies.bronze}`
  ].join(" ");
}

function statusToken(status: AccountLabel["status"], emojis: EmojiConfig): EmojiToken {
  if (status === "playing") {
    return emojis.icons.statusPlaying;
  }

  if (status === "online") {
    return emojis.icons.statusOnline;
  }

  return emojis.icons.statusOffline;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

// Живое время: клиент рендерит и сам обновляет, fallback-строка — для старых
// клиентов. format="wDT" — документированный формат из примера Bot API.
function lastOnlineTag(iso: string | null | undefined, unknownText: string): string {
  if (!iso) {
    return escapeHtml(unknownText);
  }

  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return escapeHtml(unknownText);
  }

  const unix = Math.floor(ms / 1000);
  return `<tg-time unix="${unix}" format="wDT">${escapeHtml(formatDate(iso))}</tg-time>`;
}

// Имена игроков (ники Telegram) для ячейки «Кто играет»: эскейпим каждый,
// ограничиваем длину списка с хвостом «и ещё N» (как formatParticipantList).
function joinPlayers(labels: string[], limit = 8): string {
  const escaped = labels.map(escapeHtml);
  if (escaped.length <= limit) {
    return escaped.join(", ");
  }

  return `${escaped.slice(0, limit).join(", ")} ${escapeHtml(texts.common.andMore(escaped.length - limit))}`;
}

function accountLabelHtml(account: AccountLabel, emojis: EmojiConfig): string {
  return [
    escapeHtml(account.onlineId),
    ...(account.hasPlus ? [customEmoji(emojis.icons.plus)] : []),
    getFlagEmoji(account.regionCode)
  ].join(" ");
}

// --- Высокоуровневые строители ответов ---------------------------------------

export function buildLeaderboardHtml(players: AggregatedPlayer[], emojis: EmojiConfig): string {
  const cols = texts.rich.leaderboard.cols;
  const rows = players.map((player, index) => [
    index < 3 ? MEDALS[index] : String(index + 1),
    escapeHtml(player.user.displayName),
    `<b>${player.level}</b>`,
    trophyLine(player.trophies, emojis)
  ]);

  return (
    `<h3>${texts.rich.leaderboard.title(players.length)}</h3>` +
    richTable(
      [cols.rank, cols.player, cols.level, cols.trophies],
      ["center", "left", "right", "left"],
      rows
    )
  );
}

export function buildPopularHtml(games: PopularGameAccumulator[]): string {
  const cols = texts.rich.popular.cols;
  const rows = games.map((game, index) => {
    const players = [...game.players.values()].sort((a, b) => a.localeCompare(b, "ru-RU"));
    return [
      String(index + 1),
      escapeHtml(game.name),
      `${game.players.size} · ${joinPlayers(players)}`
    ];
  });

  return (
    `<h3>${texts.rich.popular.title}</h3>` +
    richTable([cols.rank, cols.game, cols.players], ["center", "left", "left"], rows)
  );
}

export function buildSummaryHtml(
  input: {
    title: string;
    avatarUrl?: string | null;
    primaryAccount: AccountLabel;
    otherAccounts: AccountLabel[];
    level: number;
    progress: number;
    trophies: TrophyCounts;
  },
  emojis: EmojiConfig
): string {
  const account = input.primaryAccount;
  const summary = texts.rich.summary;
  const blocks: string[] = [];

  if (input.avatarUrl) {
    blocks.push(`<img src="${escapeHtml(input.avatarUrl)}"/>`);
  }

  blocks.push(`<h3>${escapeHtml(input.title)}</h3>`);

  const identity = [
    customEmoji(statusToken(account.status, emojis)),
    `<b>${escapeHtml(account.onlineId)}</b>`,
    ...(account.hasPlus ? [customEmoji(emojis.icons.plus)] : []),
    getFlagEmoji(account.regionCode)
  ].join(" ");
  blocks.push(`<p>${identity}</p>`);

  const isPlaying = account.status === "playing" && Boolean(account.currentGames?.length);
  if (isPlaying) {
    blocks.push(`<p>${escapeHtml(summary.playing(account.currentGames!.join(", ")))}</p>`);
  } else {
    blocks.push(
      `<p>${escapeHtml(summary.lastOnlineLabel)}: ${lastOnlineTag(account.lastOnline, summary.lastOnlineUnknown)}</p>`
    );
  }

  blocks.push(`<p>${escapeHtml(summary.level(input.level, input.progress))}</p>`);
  blocks.push(`<p>${trophyLine(input.trophies, emojis)}</p>`);

  const gameNames = account.currentGames?.length ? account.currentGames : account.recentGames ?? [];
  const gamesLine = isPlaying
    ? summary.recent(account.recentGames?.length ? account.recentGames.join(", ") : summary.noGames)
    : summary.games(gameNames.length > 0 ? gameNames.join(", ") : summary.noGames);
  blocks.push(`<p>${escapeHtml(gamesLine)}</p>`);

  if (input.otherAccounts.length > 0) {
    const list = input.otherAccounts.map((acc) => accountLabelHtml(acc, emojis)).join(", ");
    blocks.push(
      `<details><summary>${escapeHtml(summary.otherAccounts(input.otherAccounts.length))}</summary>${list}</details>`
    );
  }

  return blocks.join("");
}

export type PlatinumGroup = {
  titleName: string;
  platform: string;
  occurrences: Array<{ regionCode?: string; earnedAt: string }>;
};

// Платин может быть много: каждая строка таблицы = блок (лимит 500 блоков /
// 32768 символов на сообщение), поэтому режем на части по CHUNK_ROWS — заголовок
// только в первой. Возвращаем массив HTML-строк (по одной на сообщение).
export function buildPlatinumHtml(groups: PlatinumGroup[], label: string): string[] {
  const cols = texts.rich.platinum.cols;
  const escapedLabel = escapeHtml(label);
  const heading = `<h3>${texts.rich.platinum.title(escapedLabel, groups.length)}</h3>`;

  if (groups.length === 0) {
    return [heading];
  }

  const CHUNK_ROWS = 400;
  const chunks: string[] = [];
  for (let start = 0; start < groups.length; start += CHUNK_ROWS) {
    const rows = groups.slice(start, start + CHUNK_ROWS).map((group) => {
      const earliest = [...group.occurrences]
        .map((occurrence) => occurrence.earnedAt)
        .sort()[0];
      return [
        escapeHtml(group.titleName),
        escapeHtml(group.platform),
        escapeHtml(earliest ? formatDate(earliest) : "")
      ];
    });
    const table = richTable([cols.game, cols.platform, cols.earned], ["left", "left", "right"], rows);
    chunks.push(start === 0 ? heading + table : table);
  }

  return chunks;
}

// --- Транспорт ----------------------------------------------------------------

type InputRichMessage = {
  html?: string;
  markdown?: string;
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
};

type SendRichMessagePayload = {
  chat_id: number | string;
  rich_message: InputRichMessage;
  message_thread_id?: number;
  reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean };
  reply_markup?: InlineKeyboardMarkup;
  effect_id?: string;
};

// grammy 1.41.1 ещё не знает sendRichMessage — единственный каст на весь модуль.
// Идём через api.raw, чтобы переиспользовать настроенный fetch/apiRoot/таймаут и
// обёртку ошибок в GrammyError (её ловит fallback в обработчиках).
type RawWithRich = { sendRichMessage: (payload: SendRichMessagePayload) => Promise<Message> };

export async function sendRichMessage(api: Api, payload: SendRichMessagePayload): Promise<Message> {
  const raw = api.raw as unknown as RawWithRich;
  return await raw.sendRichMessage(payload);
}

// Удобная обёртка: собирает payload из html + (опц.) ответа на сообщение/клавиатуры.
// skip_entity_detection=true — чтобы Telegram не превращал куски ников/названий игр
// в ссылки/хэштеги; наша явная разметка (теги) при этом работает.
export async function sendRich(
  api: Api,
  chatId: number,
  html: string,
  options?: { replyToMessageId?: number; replyMarkup?: InlineKeyboardMarkup }
): Promise<Message> {
  return await sendRichMessage(api, {
    chat_id: chatId,
    rich_message: { html, skip_entity_detection: true },
    reply_parameters: options?.replyToMessageId
      ? { message_id: options.replyToMessageId }
      : undefined,
    reply_markup: options?.replyMarkup
  });
}
