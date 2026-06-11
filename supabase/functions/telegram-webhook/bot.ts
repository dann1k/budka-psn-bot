import { Bot, type Context, GrammyError, HttpError, InlineKeyboard, InputFile } from "npm:grammy@1.41.1/web";
import type { MessageEntity } from "npm:grammy@1.41.1/types";
import {
  formatLeaderboardRow,
  formatPlatinumRow,
  formatSummary,
  getFlagEmoji,
  type AccountLabel
} from "./format.ts";
import { LinkRepository } from "./repository.ts";
import type { PendingTelegramAction } from "./repository.ts";
import {
  PsnNpssoInvalidError,
  PsnPrivateProfileError,
  PsnService,
  type PsnPlayedGame,
  type PsnSummary,
  type PsnTrophyTitleGameSource
} from "./psn.ts";
import type { EmojiConfig, LinkedAccount, LinkedUser } from "./types.ts";
import { renderGamerCard, renderLeaderboard, renderPopularGames } from "./renderer.tsx";

type BotConfig = {
  botToken: string;
  emojis: EmojiConfig;
};

export type AggregatedPlayer = {
  user: LinkedUser;
  accountLinks: LinkedAccount[];
  accountSummaries: PsnSummary[];
  accounts: AccountLabel[];
  level: number;
  progress: number;
  trophies: {
    platinum: number;
    gold: number;
    silver: number;
    bronze: number;
  };
};

type PreferredAccount = {
  summary: PsnSummary;
  index: number;
};

type PopularGameAccumulator = {
  key: string;
  name: string;
  imageUrl: string | null;
  players: Map<number, string>;
  accounts: PopularDebugAccount[];
};

type PopularDebugAccount = {
  telegramLabel: string;
  psnOnlineId: string;
  resolvedOnlineId: string;
  accountId: string;
  titleCount: number;
};

type PopularSkippedAccount = {
  psnOnlineId: string;
  telegramLabel: string;
  reason: string;
};

type TelegramActor = {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
};

type TelegramActionContext = {
  chat: {
    id: number;
    type: string;
  };
  from?: TelegramActor;
  msg?: {
    message_id: number;
    text?: string;
  };
  reply: (text: string, other?: Record<string, unknown>) => Promise<unknown>;
  replyWithPhoto?: (photo: string | InputFile, other?: Record<string, unknown>) => Promise<unknown>;
};

type MenuAction =
  | "summary"
  | "me"
  | "table"
  | "popular"
  | "plats"
  | "region"
  | "link"
  | "default"
  | "summary_psn"
  | "unlink"
  | "close";

const PENDING_ACTION_LABELS: Record<PendingTelegramAction, string> = {
  link: "Привязать PSN",
  summary_psn: "Summary по игроку или PSN ID",
  default: "Выбрать default",
  unlink: "Отвязать PSN"
};

function ensureGroup(chatType: string): boolean {
  return chatType === "group" || chatType === "supergroup";
}

function getDisplayName(user: { first_name: string; last_name?: string }): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

function getCommandArg(text: string | undefined): string | null {
  if (!text) {
    return null;
  }

  const [, ...rest] = text.trim().split(/\s+/);
  const value = rest.join(" ").trim();
  return value.length > 0 ? value : null;
}

function getCommandArgs(text: string | undefined): string[] {
  if (!text) {
    return [];
  }

  return text.trim().split(/\s+/).slice(1);
}

function getActor(ctx: {
  from?: { id: number; username?: string; first_name: string; last_name?: string };
}) {
  return ctx.from ?? null;
}

function chunkRichMessages(
  messages: { text: string; entities: MessageEntity[] }[],
  maxLength = 3500
): { text: string; entities: MessageEntity[] }[] {
  const chunks: { text: string; entities: MessageEntity[] }[] = [];
  let currentText = "";
  let currentEntities: MessageEntity[] = [];

  for (const message of messages) {
    const separator = currentText.length === 0 ? "" : "\n";
    const nextLength = currentText.length + separator.length + message.text.length;

    if (nextLength > maxLength && currentText.length > 0) {
      chunks.push({ text: currentText, entities: currentEntities });
      currentText = "";
      currentEntities = [];
    }

    const offsetShift = currentText.length === 0 ? 0 : currentText.length + 1;
    if (currentText.length > 0) {
      currentText += "\n";
    }
    currentText += message.text;
    currentEntities.push(
      ...message.entities.map((entity) => ({
        ...entity,
        offset: entity.offset + offsetShift
      }))
    );
  }

  if (currentText.length > 0) {
    chunks.push({ text: currentText, entities: currentEntities });
  }

  return chunks;
}

function utf16Length(value: string): number {
  return [...value].reduce((length, char) => length + (char.codePointAt(0)! > 0xffff ? 2 : 1), 0);
}

function formatPsnError(error: unknown, onlineId?: string): string {
  const fallback = error instanceof Error ? error.message : "Неизвестная ошибка.";

  if (error instanceof PsnPrivateProfileError) {
    return `Профиль ${onlineId ?? "этого пользователя"} закрыт, данные о трофеях недоступны.`;
  }

  if (error instanceof PsnNpssoInvalidError) {
    return "PSN NPSSO истёк и refresh token недоступен. Обнови секрет BUDKA_PSN_NPSSO (новый код: https://ca.account.sony.com/api/v1/ssocookie) и передеплой бота.";
  }

  if (fallback.includes("User not found")) {
    return `Пользователь ${onlineId ?? "с таким ID"} не найден.`;
  }

  return fallback;
}

async function safeAnswerCallbackQuery(ctx: Context, text?: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text ? { text } : undefined);
  } catch (error) {
    // A late-processed update makes the callback query "too old"; that must not
    // crash the handler (otherwise the loading message is never cleaned up).
    console.warn(
      `[menu] answerCallbackQuery skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function formatTelegramLabel(user: Pick<LinkedUser, "username" | "displayName">): string {
  return user.username ? `@${user.username}` : user.displayName;
}

function formatTelegramName(user: Pick<LinkedUser, "displayName">): string {
  return user.displayName;
}

function formatNonMentionTelegramLabel(user: Pick<LinkedUser, "username" | "displayName">): string {
  return user.username ?? user.displayName;
}

function shiftEntities(entities: MessageEntity[], prefix: string): MessageEntity[] {
  const shift = utf16Length(prefix);
  return entities.map((entity) => ({
    ...entity,
    offset: entity.offset + shift
  }));
}

function getTrophyWeight(summary: Pick<AggregatedPlayer, "trophies">): number {
  return (
    summary.trophies.platinum * 1000 +
    summary.trophies.gold * 100 +
    summary.trophies.silver * 10 +
    summary.trophies.bronze
  );
}

async function replyToCommand(
  ctx: {
    reply: (text: string, other?: Record<string, unknown>) => Promise<unknown>;
    msg?: { message_id: number };
  },
  text: string,
  extra?: Record<string, unknown>
): Promise<void> {
  await ctx.reply(text, {
    ...extra,
    reply_parameters: ctx.msg
      ? {
          message_id: ctx.msg.message_id
        }
      : undefined
  });
}

async function replySummary(
  ctx: {
    reply: (text: string, other?: Record<string, unknown>) => Promise<unknown>;
    replyWithPhoto?: (photo: string | InputFile, other?: Record<string, unknown>) => Promise<unknown>;
    msg?: { message_id: number };
  },
  text: string,
  entities: MessageEntity[],
  avatarUrl?: string | null
): Promise<void> {
  if (avatarUrl && ctx.replyWithPhoto) {
    await ctx.replyWithPhoto(avatarUrl, {
      caption: text,
      caption_entities: entities,
      reply_parameters: ctx.msg
        ? {
            message_id: ctx.msg.message_id
          }
        : undefined
    });
    return;
  }

  await replyToCommand(ctx, text, { entities });
}

function isTelegramHandle(value: string | null): boolean {
  return Boolean(value && value.trim().startsWith("@"));
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  worker: (input: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results = new Array<TOutput>(inputs.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(inputs[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () => runWorker())
  );

  return results;
}

function parseDateMs(value: string | null | undefined): number {
  return Date.parse(value ?? "") || 0;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
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

function formatParticipantList(labels: string[], limit = 6): string {
  if (labels.length <= limit) {
    return labels.join(", ");
  }

  return `${labels.slice(0, limit).join(", ")} и ещё ${labels.length - limit}`;
}

function getPopularDebugAccountKey(account: Pick<PopularDebugAccount, "psnOnlineId" | "accountId">): string {
  return `${account.psnOnlineId.toLocaleLowerCase("ru-RU")}:${account.accountId}`;
}

function formatPopularDebugAccount(account: PopularDebugAccount): string {
  const resolvedSuffix =
    account.resolvedOnlineId.toLocaleLowerCase("ru-RU") === account.psnOnlineId.toLocaleLowerCase("ru-RU")
      ? ""
      : ` -> ${account.resolvedOnlineId}`;

  return `${account.telegramLabel} / ${account.psnOnlineId}${resolvedSuffix} -> ${account.accountId} (${account.titleCount} titles)`;
}

function formatPopularDebugAccountList(accounts: PopularDebugAccount[], limit = 6): string {
  const formatted = accounts
    .slice(0, limit)
    .map(formatPopularDebugAccount)
    .join("; ");

  if (accounts.length <= limit) {
    return formatted;
  }

  return `${formatted}; и ещё ${accounts.length - limit}`;
}

function formatPopularGameRow(game: PopularGameAccumulator, index: number): { text: string; entities: MessageEntity[] } {
  const players = [...game.players.values()]
    .sort((a, b) => a.localeCompare(b, "ru-RU"));
  const title = `${index + 1}. ${game.name}`;
  const details = `${game.players.size} ${pluralizeRu(game.players.size, [
    "участник",
    "участника",
    "участников"
  ])}: ${formatParticipantList(players)}`;
  const text = `${title}\n${details}`;

  return {
    text,
    entities: [
      { type: "bold", offset: 0, length: utf16Length(title) },
      { type: "blockquote", offset: 0, length: utf16Length(text) }
    ]
  };
}

function buildMenuCallbackData(ownerId: number, action: MenuAction): string {
  return `menu:${ownerId}:${action}`;
}

function parseMenuCallbackData(value: string | undefined): { ownerId: number; action: MenuAction } | null {
  if (!value) {
    return null;
  }

  const match = /^menu:(\d+):([a-z_]+)$/.exec(value);
  if (!match) {
    return null;
  }

  const action = match[2] as MenuAction;
  if (![
    "summary",
    "me",
    "table",
    "popular",
    "plats",
    "region",
    "link",
    "default",
    "summary_psn",
    "unlink",
    "close"
  ].includes(action)) {
    return null;
  }

  return {
    ownerId: Number(match[1]),
    action
  };
}

function buildActionMenu(ownerId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Моя сводка", buildMenuCallbackData(ownerId, "summary"))
    .text("Мои аккаунты", buildMenuCallbackData(ownerId, "me"))
    .row()
    .text("Таблица", buildMenuCallbackData(ownerId, "table"))
    .text("Популярные", buildMenuCallbackData(ownerId, "popular"))
    .row()
    .text("Платины", buildMenuCallbackData(ownerId, "plats"))
    .text("Регионы", buildMenuCallbackData(ownerId, "region"))
    .row()
    .text("Выбрать default", buildMenuCallbackData(ownerId, "default"))
    .text("Summary по игроку", buildMenuCallbackData(ownerId, "summary_psn"))
    .row()
    .text("Привязать PSN", buildMenuCallbackData(ownerId, "link"))
    .text("Отвязать PSN", buildMenuCallbackData(ownerId, "unlink"))
    .row()
    .text("Закрыть", buildMenuCallbackData(ownerId, "close"));
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: {
      status?: unknown;
    };
  };
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status;

  if (typeof status === "number") {
    return status;
  }

  if (typeof status === "string") {
    const parsed = Number.parseInt(status, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function formatPopularSkipReason(error: unknown): string {
  const status = getErrorStatus(error);
  const message = error instanceof Error ? error.message : "";
  const normalizedMessage = message.toLowerCase();

  if (status === 401 || normalizedMessage.includes("unauthorized") || normalizedMessage.includes("access token")) {
    return "ошибка авторизации PSN";
  }

  if (status === 403 || normalizedMessage.includes("forbidden") || normalizedMessage.includes("privacy")) {
    return "нет доступа или закрытая активность";
  }

  if (status === 404 || normalizedMessage.includes("user not found") || normalizedMessage.includes("not found")) {
    return "профиль или список игр не найден";
  }

  if (status && status >= 500) {
    return "временная ошибка PSN";
  }

  if (
    normalizedMessage.includes("network") ||
    normalizedMessage.includes("timeout") ||
    normalizedMessage.includes("fetch")
  ) {
    return "ошибка сети";
  }

  return message ? message.slice(0, 120) : "неизвестная ошибка";
}

export function createBot(config: BotConfig, repository: LinkRepository, psnService: PsnService): Bot {
  const bot = new Bot(config.botToken);

  async function resolveTargetUser(
    chatId: number,
    actor: { id: number } | null,
    arg: string | null
  ): Promise<LinkedUser | null> {
    if (arg) {
      return repository.findUserByUsername(chatId, arg);
    }

    if (!actor) {
      return null;
    }

    const users = await repository.listUsers(chatId);
    return users.find((user) => user.userId === actor.id) ?? null;
  }

  async function loadAggregatedPlayer(user: LinkedUser): Promise<AggregatedPlayer> {
    const accountLinks = await repository.listAccountsByUser(user.chatId, user.userId);
    const accountSummaries = await Promise.all(
      accountLinks.map((account) => psnService.getSummaryByOnlineId(account.psnOnlineId))
    );

    return {
      user,
      accountLinks,
      accountSummaries,
      accounts: accountSummaries.map((summary) => ({
        onlineId: summary.onlineId,
        regionCode: summary.region?.code,
        hasPlus: summary.hasPlus,
        status: summary.presence.status,
        lastOnline: summary.presence.lastOnline,
        currentGames: summary.presence.currentGames,
        recentGames: summary.recentGames
      })),
      level: accountSummaries.reduce((sum, summary) => sum + summary.level, 0),
      progress: Math.max(...accountSummaries.map((summary) => summary.progress), 0),
      trophies: accountSummaries.reduce(
        (sum, summary) => ({
          platinum: sum.platinum + summary.trophies.platinum,
          gold: sum.gold + summary.trophies.gold,
          silver: sum.silver + summary.trophies.silver,
          bronze: sum.bronze + summary.trophies.bronze
        }),
        { platinum: 0, gold: 0, silver: 0, bronze: 0 }
      )
    };
  }

  function pickPreferredAccount(player: AggregatedPlayer): PreferredAccount {
    const defaultOnlineId = player.user.defaultPsnOnlineId?.toLowerCase();
    if (defaultOnlineId) {
      const defaultIndex = player.accountSummaries.findIndex(
        (summary) => summary.onlineId.toLowerCase() === defaultOnlineId
      );

      if (defaultIndex >= 0) {
        return {
          summary: player.accountSummaries[defaultIndex],
          index: defaultIndex
        };
      }
    }

    const nonRuIndex = player.accountSummaries.findIndex(
      (summary) => summary.region?.code.toUpperCase() !== "RU"
    );

    if (nonRuIndex >= 0) {
      return {
        summary: player.accountSummaries[nonRuIndex],
        index: nonRuIndex
      };
    }

    return {
      summary: player.accountSummaries[0],
      index: 0
    };
  }

  async function ensureGroupContext(ctx: TelegramActionContext): Promise<boolean> {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return false;
    }

    return true;
  }

  async function requireActor(ctx: TelegramActionContext): Promise<TelegramActor | null> {
    const actor = getActor(ctx);
    if (!actor) {
      await replyToCommand(ctx, "Не удалось определить отправителя команды.");
      return null;
    }

    return actor;
  }

  async function sendActionMenu(ctx: TelegramActionContext): Promise<void> {
    if (!(await ensureGroupContext(ctx))) {
      return;
    }

    const actor = await requireActor(ctx);
    if (!actor) {
      return;
    }

    await replyToCommand(ctx, "Меню:", {
      reply_markup: buildActionMenu(actor.id)
    });
  }

  async function setPendingAction(
    ctx: TelegramActionContext,
    actor: TelegramActor,
    action: PendingTelegramAction
  ): Promise<void> {
    await repository.setPendingAction(ctx.chat.id, actor.id, action);

    const hints: Record<PendingTelegramAction, string> = {
      link: "Пришли PSN Online ID, который нужно привязать.",
      summary_psn: "Пришли @telegram участника чата или PSN Online ID. Для своей сводки можно просто нажать «Моя сводка».",
      default: "Пришли PSN Online ID из твоих привязок, который сделать default.",
      unlink: "Пришли PSN Online ID для удаления или /cancel, если передумал."
    };

    await replyToCommand(ctx, `${PENDING_ACTION_LABELS[action]}\n${hints[action]}\n\nОтмена: /cancel`);
  }

  async function handleLink(ctx: TelegramActionContext, actor: TelegramActor, onlineId: string): Promise<void> {
    const existingOwner = await repository.getAccountOwner(ctx.chat.id, onlineId);
    if (existingOwner && existingOwner.userId !== actor.id) {
      await replyToCommand(
        ctx,
        `Профиль ${existingOwner.psnOnlineId} уже привязан в этой группе к ${formatTelegramLabel(existingOwner)}.`
      );
      return;
    }

    if (existingOwner && existingOwner.userId === actor.id) {
      await replyToCommand(ctx, `Профиль ${existingOwner.psnOnlineId} уже привязан к тебе.`);
      return;
    }

    try {
      const summary = await psnService.getSummaryByOnlineId(onlineId);
      const canonicalOwner = await repository.getAccountOwner(ctx.chat.id, summary.onlineId);

      if (canonicalOwner && canonicalOwner.userId !== actor.id) {
        await replyToCommand(
          ctx,
          `Профиль ${canonicalOwner.psnOnlineId} уже привязан в этой группе к ${formatTelegramLabel(canonicalOwner)}.`
        );
        return;
      }

      if (canonicalOwner && canonicalOwner.userId === actor.id) {
        await replyToCommand(ctx, `Профиль ${canonicalOwner.psnOnlineId} уже привязан к тебе.`);
        return;
      }

      await repository.addLink({
        chatId: ctx.chat.id,
        userId: actor.id,
        username: actor.username ?? null,
        displayName: getDisplayName(actor),
        psnOnlineId: summary.onlineId
      });

      const aggregated = await loadAggregatedPlayer({
        chatId: ctx.chat.id,
        userId: actor.id,
        username: actor.username ?? null,
        displayName: getDisplayName(actor),
        defaultPsnOnlineId: null
      });
      const preferred = pickPreferredAccount(aggregated);
      const summaryMessage = formatSummary(
        {
          primaryAccount: aggregated.accounts[preferred.index],
          otherAccounts: aggregated.accounts.filter((_, index) => index !== preferred.index),
          level: aggregated.level,
          progress: aggregated.progress,
          trophies: aggregated.trophies
        },
        config.emojis
      );
      const prefix = `Добавил аккаунт ${summary.onlineId}.\n\n`;

      await replyToCommand(ctx, `${prefix}${summaryMessage.text}`, {
        entities: summaryMessage.entities.map((entity) => ({
          ...entity,
          offset: entity.offset + utf16Length(prefix)
        }))
      });
    } catch (error) {
      const message = formatPsnError(error, onlineId);
      await replyToCommand(ctx, `Не получилось привязать профиль: ${message}`);
    }
  }

  async function handleMe(ctx: TelegramActionContext, actor: TelegramActor): Promise<void> {
    const accounts = await repository.listAccountsByUser(ctx.chat.id, actor.id);
    if (accounts.length === 0) {
      await replyToCommand(ctx, "У тебя пока нет привязок. Используй /link <online-id> или /menu.");
      return;
    }

    await repository.syncUserMetadata({
      chatId: ctx.chat.id,
      userId: actor.id,
      username: actor.username ?? null,
      displayName: getDisplayName(actor)
    });

    await replyToCommand(
      ctx,
      `Твои аккаунты: ${accounts.map((account) => account.psnOnlineId).join(", ")}`
    );
  }

  async function handleSummary(ctx: TelegramActionContext, actor: TelegramActor | null, targetArg: string | null): Promise<void> {
    if (targetArg && !isTelegramHandle(targetArg)) {
      try {
        const summary = await psnService.getSummaryByOnlineId(targetArg);
        const mockPlayer: AggregatedPlayer = {
          user: {
            userId: 0,
            chatId: ctx.chat.id,
            username: null,
            displayName: "Данные из PSN",
            defaultPsnOnlineId: null
          },
          accountLinks: [],
          accountSummaries: [summary],
          accounts: [],
          level: summary.level,
          progress: summary.progress,
          trophies: summary.trophies
        };

        const cardPng = await renderGamerCard(mockPlayer, summary);
        if (ctx.replyWithPhoto) {
          await ctx.replyWithPhoto(new InputFile(cardPng, `${summary.onlineId}_card.png`), ctx.msg
            ? {
                reply_parameters: {
                  message_id: ctx.msg.message_id
                }
              }
            : undefined
          );
        } else {
          await replyToCommand(ctx, "Интерфейс отправки фото недоступен.");
        }
      } catch (error) {
        const message = formatPsnError(error, targetArg);
        await replyToCommand(ctx, `Не получилось получить сводку: ${message}`);
      }
      return;
    }

    const targetUser = await resolveTargetUser(ctx.chat.id, actor, targetArg);

    if (!targetUser) {
      await replyToCommand(
        ctx,
        targetArg
          ? `Не нашёл игрока ${targetArg} среди привязанных пользователей.`
          : "Сначала привяжи хотя бы один профиль через /link <online-id> или /menu."
      );
      return;
    }

    try {
      const aggregated = await loadAggregatedPlayer(targetUser);
      const preferred = pickPreferredAccount(aggregated);
      const cardPng = await renderGamerCard(aggregated, preferred.summary);

      if (ctx.replyWithPhoto) {
        await ctx.replyWithPhoto(new InputFile(cardPng, `${preferred.summary.onlineId}_card.png`), ctx.msg
          ? {
              reply_parameters: {
                message_id: ctx.msg.message_id
              }
            }
          : undefined
        );
      } else {
        await replyToCommand(ctx, "Интерфейс отправки фото недоступен.");
      }
    } catch (error) {
      const message = formatPsnError(error);
      await replyToCommand(ctx, `Не получилось получить сводку: ${message}`);
    }
  }

  async function handleDefault(ctx: TelegramActionContext, actor: TelegramActor, onlineId: string): Promise<void> {
    const accounts = await repository.listAccountsByUser(ctx.chat.id, actor.id);
    const match = accounts.find((account) => account.psnOnlineId.toLowerCase() === onlineId.toLowerCase());

    if (!match) {
      await replyToCommand(ctx, `У тебя нет привязки к ${onlineId}.`);
      return;
    }

    await repository.setDefaultAccount(ctx.chat.id, actor.id, match.psnOnlineId);
    await replyToCommand(ctx, `Приоритетный аккаунт для summary: ${match.psnOnlineId}`);
  }

  async function handleRegion(ctx: TelegramActionContext, actor: TelegramActor | null, targetArg: string | null): Promise<void> {
    const targetUser = await resolveTargetUser(ctx.chat.id, actor, targetArg);

    if (!targetUser) {
      await replyToCommand(
        ctx,
        targetArg
          ? `Не нашёл игрока ${targetArg} среди привязанных пользователей.`
          : "Сначала привяжи хотя бы один профиль через /link <online-id> или /menu."
      );
      return;
    }

    try {
      const aggregated = await loadAggregatedPlayer(targetUser);
      const regionText = aggregated.accounts
        .map((account) => `${account.onlineId} ${getFlagEmoji(account.regionCode)}`)
        .join(", ");

      await replyToCommand(ctx, `${formatTelegramLabel(targetUser)}: ${regionText}`);
    } catch (error) {
      const message = formatPsnError(error);
      await replyToCommand(ctx, `Не получилось получить регион: ${message}`);
    }
  }

  async function handlePlats(ctx: TelegramActionContext, actor: TelegramActor | null, targetArg: string | null): Promise<void> {
    const targetUser = await resolveTargetUser(ctx.chat.id, actor, targetArg);

    if (!targetUser) {
      await replyToCommand(
        ctx,
        targetArg
          ? `Не нашёл игрока ${targetArg} среди привязанных пользователей.`
          : "Сначала привяжи хотя бы один профиль через /link <online-id> или /menu."
      );
      return;
    }

    try {
      const accounts = await repository.listAccountsByUser(ctx.chat.id, targetUser.userId);
      const perAccountTitles = await Promise.all(
        accounts.map((account) => psnService.getPlatinumTitlesByOnlineId(account.psnOnlineId))
      );
      const titles = perAccountTitles.flat();

      if (titles.length === 0) {
        await replyToCommand(ctx, `У игрока ${formatTelegramLabel(targetUser)} пока нет платин.`);
        return;
      }

      const groupedTitles = new Map<
        string,
        {
          titleName: string;
          platform: string;
          occurrences: Array<{ regionCode?: string; earnedAt: string }>;
        }
      >();

      for (const title of titles) {
        const key = `${title.titleName.trim().toLocaleLowerCase("ru-RU")}__${title.platform}`;
        const existing = groupedTitles.get(key);

        if (existing) {
          existing.occurrences.push({
            regionCode: title.region?.code,
            earnedAt: title.earnedAt
          });
          continue;
        }

        groupedTitles.set(key, {
          titleName: title.titleName,
          platform: title.platform,
          occurrences: [
            {
              regionCode: title.region?.code,
              earnedAt: title.earnedAt
            }
          ]
        });
      }

      const normalizedTitleCounts = new Map<string, number>();
      for (const group of groupedTitles.values()) {
        const normalizedTitle = group.titleName.trim().toLocaleLowerCase("ru-RU");
        normalizedTitleCounts.set(normalizedTitle, (normalizedTitleCounts.get(normalizedTitle) ?? 0) + 1);
      }

      const sortedGroups = [...groupedTitles.values()].sort((a, b) => {
        const aDate = Math.max(...a.occurrences.map((occurrence) => Date.parse(occurrence.earnedAt) || 0));
        const bDate = Math.max(...b.occurrences.map((occurrence) => Date.parse(occurrence.earnedAt) || 0));
        return bDate - aDate;
      });

      const messages = chunkRichMessages([
        {
          text: `Платины ${formatTelegramLabel(targetUser)} (${sortedGroups.length}):\n`,
          entities: [
            {
              type: "bold",
              offset: utf16Length("Платины "),
              length: utf16Length(formatTelegramLabel(targetUser))
            }
          ]
        },
        ...sortedGroups.map((group) =>
          formatPlatinumRow(
            {
              titleName: group.titleName,
              platform: group.platform,
              occurrences: group.occurrences.sort(
                (a, b) => (Date.parse(a.earnedAt) || 0) - (Date.parse(b.earnedAt) || 0)
              )
            },
            config.emojis,
            {
              showPlatform:
                (normalizedTitleCounts.get(group.titleName.trim().toLocaleLowerCase("ru-RU")) ?? 0) > 1,
              showRegions: group.occurrences.length > 1
            }
          )
        )
      ]);

      for (const [index, message] of messages.entries()) {
        await ctx.reply(
          message.text,
          index === 0 && ctx.msg
            ? {
                entities: message.entities,
                reply_parameters: {
                  message_id: ctx.msg.message_id
                }
              }
            : {
                entities: message.entities
              }
        );
      }
    } catch (error) {
      const message = formatPsnError(error);
      await replyToCommand(ctx, `Не получилось получить платины: ${message}`);
    }
  }

  async function handleUnlink(ctx: TelegramActionContext, actor: TelegramActor, onlineId: string | null): Promise<void> {
    const deleted = await repository.deleteLinks(ctx.chat.id, actor.id, onlineId ?? undefined);

    if (deleted === 0) {
      await replyToCommand(
        ctx,
        onlineId
          ? `У тебя нет привязки к ${onlineId}.`
          : "Для тебя в этом чате не было сохранённых привязок."
      );
      return;
    }

    await replyToCommand(
      ctx,
      onlineId
        ? `Удалил привязку ${onlineId}.`
        : `Удалил все твои привязки (${deleted}).`
    );
  }

  async function handlePopular(ctx: TelegramActionContext, commandArgs: string[] = []): Promise<void> {
    const isDebug = commandArgs[0]?.toLowerCase() === "debug";
    const debugSearch = isDebug ? commandArgs.slice(1).join(" ").trim() : "";
    const normalizedDebugSearch = normalizeSearchText(debugSearch);
    const users = await repository.listUsers(ctx.chat.id);
    if (users.length === 0) {
      await replyToCommand(ctx, "В этой группе пока нет привязанных PSN-профилей.");
      return;
    }

    const accountsByUser = await Promise.all(
      users.map(async (user) => ({
        user,
        accounts: await repository.listAccountsByUser(ctx.chat.id, user.userId)
      }))
    );
    const accountJobs = accountsByUser.flatMap(({ user, accounts }) =>
      accounts.map((account) => ({
        user,
        psnOnlineId: account.psnOnlineId
      }))
    );

    if (accountJobs.length === 0) {
      await replyToCommand(ctx, "В этой группе пока нет привязанных PSN-профилей.");
      return;
    }

    const results = await mapWithConcurrency(accountJobs, 3, async (job) => {
      try {
        const source = await psnService.getTrophyTitleGamesByOnlineId(job.psnOnlineId);

        return {
          user: job.user,
          psnOnlineId: job.psnOnlineId,
          source,
          games: source.games,
          skipped: null as PopularSkippedAccount | null
        };
      } catch (error) {
        console.error(`Could not load popular game source data for ${job.psnOnlineId}:`, error);
        return {
          user: job.user,
          psnOnlineId: job.psnOnlineId,
          source: null as PsnTrophyTitleGameSource | null,
          games: [] as PsnPlayedGame[],
          skipped: {
            psnOnlineId: job.psnOnlineId,
            telegramLabel: formatNonMentionTelegramLabel(job.user),
            reason: formatPopularSkipReason(error)
          }
        };
      }
    });

    const skippedAccounts = results.flatMap((result) => result.skipped ? [result.skipped] : []);
    const loadedAccounts = results.flatMap((result) => result.source
      ? [
          {
            telegramLabel: formatNonMentionTelegramLabel(result.user),
            psnOnlineId: result.psnOnlineId,
            resolvedOnlineId: result.source.resolvedOnlineId,
            accountId: result.source.accountId,
            titleCount: result.source.titleCount
          }
        ]
      : []);
    const accountHitsByGame = new Map<string, PopularDebugAccount[]>();
    const gamesByUser = new Map<number, {
      user: LinkedUser;
      games: Map<string, PsnPlayedGame>;
    }>();

    for (const result of results) {
      if (result.skipped) {
        continue;
      }

      const existingUserGames = gamesByUser.get(result.user.userId) ?? {
        user: result.user,
        games: new Map<string, PsnPlayedGame>()
      };
      const debugAccount = result.source
        ? {
            telegramLabel: formatNonMentionTelegramLabel(result.user),
            psnOnlineId: result.psnOnlineId,
            resolvedOnlineId: result.source.resolvedOnlineId,
            accountId: result.source.accountId,
            titleCount: result.source.titleCount
          }
        : null;

      for (const game of result.games) {
        const existingGame = existingUserGames.games.get(game.key);

        if (!existingGame || parseDateMs(game.lastPlayedAt) > parseDateMs(existingGame.lastPlayedAt)) {
          existingUserGames.games.set(game.key, game);
        }

        if (debugAccount) {
          const hits = accountHitsByGame.get(game.key) ?? [];
          hits.push(debugAccount);
          accountHitsByGame.set(game.key, hits);
        }
      }

      gamesByUser.set(result.user.userId, existingUserGames);
    }

    const popularGames = new Map<string, PopularGameAccumulator>();

    for (const { user, games } of gamesByUser.values()) {
      for (const game of games.values()) {
        const existing = popularGames.get(game.key) ?? {
          key: game.key,
          name: game.name,
          imageUrl: game.imageUrl,
          players: new Map<number, string>(),
          accounts: accountHitsByGame.get(game.key) ?? []
        };

        existing.name = game.name;
        existing.imageUrl ??= game.imageUrl;
        existing.accounts = accountHitsByGame.get(game.key) ?? existing.accounts;
        existing.players.set(user.userId, formatNonMentionTelegramLabel(user));
        popularGames.set(game.key, existing);
      }
    }

    if (popularGames.size === 0) {
      await replyToCommand(
        ctx,
        skippedAccounts.length > 0
          ? "Не получилось собрать популярные игры: доступных данных нет."
          : "Не нашёл сыгранных игр у привязанных участников."
      );
      return;
    }

    const topGames = [...popularGames.values()]
      .sort((a, b) => {
        if (b.players.size !== a.players.size) {
          return b.players.size - a.players.size;
        }

        return a.name.localeCompare(b.name, "ru-RU");
      })
      .slice(0, 5);
    const matchingDebugGames = normalizedDebugSearch
      ? [...popularGames.values()]
          .filter((game) => normalizeSearchText(game.name).includes(normalizedDebugSearch))
          .sort((a, b) => {
            if (b.players.size !== a.players.size) {
              return b.players.size - a.players.size;
            }

            return a.name.localeCompare(b.name, "ru-RU");
          })
      : [];
    const debugMatchedAccountKeys = new Set(
      matchingDebugGames.flatMap((game) =>
        game.accounts.map((account) => getPopularDebugAccountKey(account))
      )
    );
    const debugAccountsWithoutMatch = normalizedDebugSearch
      ? loadedAccounts.filter((account) => !debugMatchedAccountKeys.has(getPopularDebugAccountKey(account)))
      : [];

    if (!isDebug && ctx.replyWithPhoto) {
      const renderInput = topGames.map((game) => ({
        name: game.name,
        imageUrl: game.imageUrl,
        players: [...game.players.values()].sort((a, b) => a.localeCompare(b, "ru-RU"))
      }));
      const totalPlayers = renderInput.reduce((sum, g) => sum + g.players.length, 0);
      console.log(
        `[popular] start render: games=${renderInput.length} totalPlayers=${totalPlayers}`,
      );

      try {
        const renderStartedAt = Date.now();
        const popularPng = await renderPopularGames(renderInput);
        const renderDurationMs = Date.now() - renderStartedAt;
        console.log(
          `[popular] render done: bytes=${popularPng.byteLength} durationMs=${renderDurationMs}`,
        );

        const uploadStartedAt = Date.now();
        await ctx.replyWithPhoto(new InputFile(popularPng, "popular-games.png"), ctx.msg
          ? {
              reply_parameters: {
                message_id: ctx.msg.message_id
              }
            }
          : undefined
        );
        console.log(`[popular] upload done: durationMs=${Date.now() - uploadStartedAt}`);
        return;
      } catch (error) {
        console.error("[popular] render or upload failed:", error);
        const message = error instanceof Error ? error.message : "Не удалось отрендерить карточку.";
        await replyToCommand(ctx, `Не получилось собрать популярные игры: ${message}`);
        return;
      }
    }

    const messages = chunkRichMessages([
      { text: "Популярные игры чата", entities: [] },
      ...topGames.map((game, index) => formatPopularGameRow(game, index)),
      ...(isDebug && debugSearch
        ? [
            { text: `Debug по игре: ${debugSearch}`, entities: [] },
            {
              text: `Проверено аккаунтов: ${loadedAccounts.length}, с совпадениями: ${debugMatchedAccountKeys.size}`,
              entities: []
            },
            ...(matchingDebugGames.length > 0
              ? matchingDebugGames
                  .slice(0, 20)
                  .map((game) => {
                    const players = [...game.players.values()]
                      .sort((a, b) => a.localeCompare(b, "ru-RU"));
                    const accounts = [...game.accounts]
                      .sort((a, b) => formatPopularDebugAccount(a).localeCompare(
                        formatPopularDebugAccount(b),
                        "ru-RU"
                      ));
                    const text = [
                      `- ${game.name} — ${game.players.size} ${pluralizeRu(game.players.size, [
                        "участник",
                        "участника",
                        "участников"
                      ])}: ${formatParticipantList(players)}`,
                      `  аккаунты: ${formatPopularDebugAccountList(accounts)}`
                    ].join("\n");

                    return { text, entities: [] };
                  })
              : [{ text: "Совпадений не найдено.", entities: [] }]),
            ...(matchingDebugGames.length > 20
              ? [{ text: `...и ещё ${matchingDebugGames.length - 20}`, entities: [] }]
              : []),
            ...(debugAccountsWithoutMatch.length > 0
              ? [
                  { text: "Проверенные аккаунты без совпадений:", entities: [] },
                  ...debugAccountsWithoutMatch
                    .slice(0, 10)
                    .map((account) => ({ text: `- ${formatPopularDebugAccount(account)}`, entities: [] })),
                  ...(debugAccountsWithoutMatch.length > 10
                    ? [{ text: `...и ещё ${debugAccountsWithoutMatch.length - 10}`, entities: [] }]
                    : [])
                ]
              : [])
          ]
        : [])
    ]);

    for (const [index, message] of messages.entries()) {
      await ctx.reply(
        message.text,
        index === 0 && ctx.msg
          ? {
              entities: message.entities,
              reply_parameters: {
                message_id: ctx.msg.message_id
              }
            }
          : {
              entities: message.entities
            }
      );
    }
  }

  async function handleTable(ctx: TelegramActionContext): Promise<void> {
    const users = await repository.listUsers(ctx.chat.id);
    if (users.length === 0) {
      await replyToCommand(ctx, "В этой группе пока нет привязанных PSN-профилей.");
      return;
    }

    try {
      const aggregateStartedAt = Date.now();
      const aggregatedPlayers = await Promise.all(users.map((user) => loadAggregatedPlayer(user)));
      console.log(
        `[table] aggregated players=${aggregatedPlayers.length} ms=${Date.now() - aggregateStartedAt}`,
      );

      const sorted = aggregatedPlayers.sort((a, b) => {
        if (b.level !== a.level) {
          return b.level - a.level;
        }

        return getTrophyWeight(b) - getTrophyWeight(a);
      });

      const renderStartedAt = Date.now();
      const tablePng = await renderLeaderboard(sorted);
      console.log(
        `[table] render done bytes=${tablePng.byteLength} ms=${Date.now() - renderStartedAt}`,
      );

      if (ctx.replyWithPhoto) {
        const uploadStartedAt = Date.now();
        await ctx.replyWithPhoto(new InputFile(tablePng, "leaderboard.png"), ctx.msg
          ? {
              reply_parameters: {
                message_id: ctx.msg.message_id
              }
            }
          : undefined
        );
        console.log(`[table] upload done ms=${Date.now() - uploadStartedAt}`);
      } else {
        await replyToCommand(ctx, "Интерфейс отправки фото недоступен.");
      }
    } catch (error) {
      console.error("[table] failed:", error);
      const message =
        error instanceof Error ? formatPsnError(error) : "Не удалось получить данные части профилей.";
      await replyToCommand(ctx, `Не получилось собрать таблицу: ${message}`);
    }
  }

  async function sendHelp(ctx: TelegramActionContext) {
    const actor = getActor(ctx);
    const canShowMenu = actor && ensureGroup(ctx.chat.type);

    await replyToCommand(
      ctx,
      [
        "Я бот для привязки участников чата к нескольким PSN-аккаунтам.",
        "",
        "Основной вход: /menu",
        "В меню есть кнопки для сводки, таблицы, популярных игр, платин, регионов и действий с PSN ID.",
        "",
        "Быстрые команды остаются доступны:",
        "/menu — открыть персональное меню",
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
        "/unlink [online-id] — удалить один аккаунт или все свои привязки",
        "/cancel — отменить ввод PSN ID после кнопки меню",
        "/help — показать эту справку"
      ].join("\n"),
      canShowMenu
        ? {
            reply_markup: buildActionMenu(actor.id)
          }
        : undefined
    );
  }

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text?.trim();
    if (text?.startsWith("/") && !text.startsWith("/cancel") && ctx.chat && ensureGroup(ctx.chat.type) && ctx.from) {
      await repository.clearPendingAction(ctx.chat.id, ctx.from.id);
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    await sendHelp(ctx);
  });

  bot.command("help", async (ctx) => {
    await sendHelp(ctx);
  });

  bot.command("menu", async (ctx) => {
    await sendActionMenu(ctx);
  });

  bot.command("cancel", async (ctx) => {
    if (!(await ensureGroupContext(ctx))) {
      return;
    }

    const actor = await requireActor(ctx);
    if (!actor) {
      return;
    }

    await repository.clearPendingAction(ctx.chat.id, actor.id);
    await replyToCommand(ctx, "Ок, отменил ожидаемое действие.");
  });

  bot.command("link", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const onlineId = getCommandArg(ctx.message?.text);
    if (!onlineId) {
      await replyToCommand(ctx, "Укажи PSN Online ID: /link your-online-id");
      return;
    }

    const actor = getActor(ctx);
    if (!actor) {
      await replyToCommand(ctx, "Не удалось определить отправителя команды.");
      return;
    }

    await handleLink(ctx, actor, onlineId);
  });

  bot.command("me", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const actor = getActor(ctx);
    if (!actor) {
      await replyToCommand(ctx, "Не удалось определить отправителя команды.");
      return;
    }

    await handleMe(ctx, actor);
  });

  bot.command("summary", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const actor = getActor(ctx);
    const targetArg = getCommandArg(ctx.message?.text);

    await handleSummary(ctx, actor, targetArg);
  });

  bot.command("default", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const actor = getActor(ctx);
    if (!actor) {
      await replyToCommand(ctx, "Не удалось определить отправителя команды.");
      return;
    }

    const onlineId = getCommandArg(ctx.message?.text);
    if (!onlineId) {
      await replyToCommand(ctx, "Укажи PSN Online ID: /default your-online-id");
      return;
    }

    await handleDefault(ctx, actor, onlineId);
  });

  bot.command("region", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const actor = getActor(ctx);
    const targetArg = getCommandArg(ctx.message?.text);
    await handleRegion(ctx, actor, targetArg);
  });

  bot.command("plats", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const actor = getActor(ctx);
    const targetArg = getCommandArg(ctx.message?.text);
    await handlePlats(ctx, actor, targetArg);
  });

  bot.command("unlink", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const actor = getActor(ctx);
    if (!actor) {
      await replyToCommand(ctx, "Не удалось определить отправителя команды.");
      return;
    }

    await handleUnlink(ctx, actor, getCommandArg(ctx.message?.text));
  });

  bot.command("popular", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    await handlePopular(ctx, getCommandArgs(ctx.message?.text));
  });

  bot.command("table", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    await handleTable(ctx);
  });

  bot.callbackQuery(/^menu:/, async (ctx) => {
    const callbackReceivedAt = Date.now();
    const callback = parseMenuCallbackData(ctx.callbackQuery.data);
    if (!callback) {
      await safeAnswerCallbackQuery(ctx, "Неизвестное действие меню.");
      return;
    }

    const actor = getActor(ctx);
    if (!actor) {
      await safeAnswerCallbackQuery(ctx, "Не удалось определить отправителя.");
      return;
    }

    if (actor.id !== callback.ownerId) {
      await safeAnswerCallbackQuery(ctx, "Это меню другого участника. Отправь /menu");
      return;
    }

    const answerStartedAt = Date.now();
    await safeAnswerCallbackQuery(ctx);
    console.log(
      `[menu] action=${callback.action} answerCallbackQuery ms=${Date.now() - answerStartedAt} sinceCallback=${Date.now() - callbackReceivedAt}`,
    );

    if (callback.action === "close") {
      try {
        await ctx.deleteMessage();
      } catch {
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        } catch {
          await replyToCommand(ctx, "Меню закрыто.");
        }
      }
      return;
    }

    if (!ctx.chat || !ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const actionCtx = ctx as unknown as TelegramActionContext;
    const loadingMessage = await ctx.reply("Пожалуйста, подождите", {
      reply_parameters: ctx.msg
        ? {
            message_id: ctx.msg.message_id
          }
        : undefined
    });
    const loadingMessageId = loadingMessage.message_id;

    const actionStartedAt = Date.now();
    try {
      switch (callback.action) {
        case "summary":
          await handleSummary(actionCtx, actor, null);
          return;
        case "me":
          await handleMe(actionCtx, actor);
          return;
        case "table":
          await handleTable(actionCtx);
          return;
        case "popular":
          await handlePopular(actionCtx);
          return;
        case "plats":
          await handlePlats(actionCtx, actor, null);
          return;
        case "region":
          await handleRegion(actionCtx, actor, null);
          return;
        case "link":
        case "default":
        case "summary_psn":
        case "unlink":
          await setPendingAction(actionCtx, actor, callback.action);
          return;
      }
    } finally {
      console.log(
        `[menu] action=${callback.action} handler totalMs=${Date.now() - actionStartedAt} sinceCallback=${Date.now() - callbackReceivedAt}`,
      );
      try {
        await ctx.api.deleteMessage(ctx.chat.id, loadingMessageId);
      } catch {
        // Best-effort cleanup: the main bot response should not fail if Telegram refuses deletion.
      }
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    if (text.startsWith("/")) {
      return;
    }

    if (!ensureGroup(ctx.chat.type)) {
      return;
    }

    const actor = getActor(ctx);
    if (!actor) {
      return;
    }

    const pending = await repository.getPendingAction(ctx.chat.id, actor.id);
    if (!pending) {
      return;
    }

    if (Date.parse(pending.expires_at) <= Date.now()) {
      await repository.clearPendingAction(ctx.chat.id, actor.id);
      await replyToCommand(ctx, "Ожидаемое действие истекло. Открой /menu и попробуй ещё раз.");
      return;
    }

    await repository.clearPendingAction(ctx.chat.id, actor.id);

    switch (pending.action) {
      case "link":
        await handleLink(ctx, actor, text);
        return;
      case "summary_psn":
        await handleSummary(ctx, actor, text);
        return;
      case "default":
        await handleDefault(ctx, actor, text);
        return;
      case "unlink":
        await handleUnlink(ctx, actor, text);
        return;
    }
  });

  bot.catch((error) => {
    const ctx = error.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);

    const e = error.error;
    if (e instanceof GrammyError) {
      console.error("Telegram API error:", e.description);
      return;
    }

    if (e instanceof HttpError) {
      console.error("Network error:", e);
      return;
    }

    console.error("Unknown bot error:", e);
  });

  return bot;
}
