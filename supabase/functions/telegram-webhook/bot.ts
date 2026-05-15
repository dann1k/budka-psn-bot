import { Bot, GrammyError, HttpError } from "npm:grammy@1.41.1/web";
import type { MessageEntity } from "npm:grammy@1.41.1/types";
import {
  formatLeaderboardRow,
  formatPlatinumRow,
  formatSummary,
  getFlagEmoji,
  type AccountLabel
} from "./format.ts";
import { LinkRepository } from "./repository.ts";
import {
  PsnPrivateProfileError,
  PsnService,
  type PsnPlayedGame,
  type PsnSummary
} from "./psn.ts";
import type { EmojiConfig, LinkedAccount, LinkedUser } from "./types.ts";

type BotConfig = {
  botToken: string;
  emojis: EmojiConfig;
};

type AggregatedPlayer = {
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
  players: Map<number, string>;
};

type PopularSkippedAccount = {
  psnOnlineId: string;
  telegramLabel: string;
  reason: string;
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

  if (fallback.includes("User not found")) {
    return `Пользователь ${onlineId ?? "с таким ID"} не найден.`;
  }

  return fallback;
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
    replyWithPhoto?: (photo: string, other?: Record<string, unknown>) => Promise<unknown>;
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

  async function sendHelp(ctx: {
    reply: (text: string, other?: Record<string, unknown>) => Promise<unknown>;
    msg?: { message_id: number };
  }) {
    await replyToCommand(
      ctx,
      [
        "Я бот для привязки участников чата к нескольким PSN-аккаунтам.",
        "Команды:",
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
        "/help — показать эту справку"
      ].join("\n")
    );
  }

  bot.command("start", async (ctx) => {
    await sendHelp(ctx);
  });

  bot.command("help", async (ctx) => {
    await sendHelp(ctx);
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

    const accounts = await repository.listAccountsByUser(ctx.chat.id, actor.id);
    if (accounts.length === 0) {
      await replyToCommand(ctx, "У тебя пока нет привязок. Используй /link <online-id>.");
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
  });

  bot.command("summary", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const actor = getActor(ctx);
    const targetArg = getCommandArg(ctx.message?.text);

    if (targetArg && !isTelegramHandle(targetArg)) {
      try {
        const summary = await psnService.getSummaryByOnlineId(targetArg);
        const summaryMessage = formatSummary(
          {
            primaryAccount: {
              onlineId: summary.onlineId,
              regionCode: summary.region?.code,
              hasPlus: summary.hasPlus,
              status: summary.presence.status,
              lastOnline: summary.presence.lastOnline,
              currentGames: summary.presence.currentGames,
              recentGames: summary.recentGames
            },
            otherAccounts: [],
            level: summary.level,
            progress: summary.progress,
            trophies: summary.trophies
          },
          config.emojis
        );
        const prefix = "Данные напрямую из PSN\n\n";

        await replySummary(
          ctx,
          `${prefix}${summaryMessage.text}`,
          shiftEntities(summaryMessage.entities, prefix),
          summary.avatarUrl
        );
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
          : "Сначала привяжи хотя бы один профиль через /link <online-id>."
      );
      return;
    }

    try {
      const aggregated = await loadAggregatedPlayer(targetUser);
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
      const prefix = `${formatTelegramName(targetUser)}\n\n`;
      await replySummary(
        ctx,
        `${prefix}${summaryMessage.text}`,
        shiftEntities(summaryMessage.entities, prefix),
        preferred.summary.avatarUrl
      );
    } catch (error) {
      const message = formatPsnError(error);
      await replyToCommand(ctx, `Не получилось получить сводку: ${message}`);
    }
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

    const accounts = await repository.listAccountsByUser(ctx.chat.id, actor.id);
    const match = accounts.find((account) => account.psnOnlineId.toLowerCase() === onlineId.toLowerCase());

    if (!match) {
      await replyToCommand(ctx, `У тебя нет привязки к ${onlineId}.`);
      return;
    }

    await repository.setDefaultAccount(ctx.chat.id, actor.id, match.psnOnlineId);
    await replyToCommand(ctx, `Приоритетный аккаунт для summary: ${match.psnOnlineId}`);
  });

  bot.command("region", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const actor = getActor(ctx);
    const targetArg = getCommandArg(ctx.message?.text);
    const targetUser = await resolveTargetUser(ctx.chat.id, actor, targetArg);

    if (!targetUser) {
      await replyToCommand(
        ctx,
        targetArg
          ? `Не нашёл игрока ${targetArg} среди привязанных пользователей.`
          : "Сначала привяжи хотя бы один профиль через /link <online-id>."
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
  });

  bot.command("plats", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const actor = getActor(ctx);
    const targetArg = getCommandArg(ctx.message?.text);
    const targetUser = await resolveTargetUser(ctx.chat.id, actor, targetArg);

    if (!targetUser) {
      await replyToCommand(
        ctx,
        targetArg
          ? `Не нашёл игрока ${targetArg} среди привязанных пользователей.`
          : "Сначала привяжи хотя бы один профиль через /link <online-id>."
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

    const onlineId = getCommandArg(ctx.message?.text);
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
  });

  bot.command("popular", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const commandArgs = getCommandArgs(ctx.message?.text);
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
        return {
          user: job.user,
          psnOnlineId: job.psnOnlineId,
          games: await psnService.getPlayedGamesByOnlineId(job.psnOnlineId),
          skipped: null as PopularSkippedAccount | null
        };
      } catch (error) {
        console.error(`Could not load played games for ${job.psnOnlineId}:`, error);
        return {
          user: job.user,
          psnOnlineId: job.psnOnlineId,
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

      for (const game of result.games) {
        const existingGame = existingUserGames.games.get(game.key);

        if (!existingGame || parseDateMs(game.lastPlayedAt) > parseDateMs(existingGame.lastPlayedAt)) {
          existingUserGames.games.set(game.key, game);
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
          players: new Map<number, string>()
        };

        existing.name = game.name;
        existing.players.set(user.userId, formatNonMentionTelegramLabel(user));
        popularGames.set(game.key, existing);
      }
    }

    if (popularGames.size === 0) {
      await replyToCommand(
        ctx,
        skippedAccounts.length > 0
          ? [
              `Не получилось собрать популярные игры: все ${skippedAccounts.length} аккаунтов недоступны.`,
              ...(isDebug
                ? [
                    "",
                    "Пропущенные аккаунты:",
                    ...skippedAccounts
                      .slice(0, 10)
                      .map((account) => `- ${account.psnOnlineId} (${account.telegramLabel}): ${account.reason}`)
                  ]
                : [])
            ].join("\n")
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

    const lines = [
      "Популярные игры чата",
      "",
      ...topGames.map((game, index) => {
        const players = [...game.players.values()]
          .sort((a, b) => a.localeCompare(b, "ru-RU"));

        return `${index + 1}. ${game.name} — ${game.players.size} ${pluralizeRu(game.players.size, [
          "участник",
          "участника",
          "участников"
        ])}: ${formatParticipantList(players)}`;
      }),
      ...(skippedAccounts.length > 0 ? ["", `Пропущено аккаунтов: ${skippedAccounts.length}`] : []),
      ...(isDebug && debugSearch
        ? [
            "",
            `Debug по игре: ${debugSearch}`,
            ...(matchingDebugGames.length > 0
              ? matchingDebugGames
                  .slice(0, 20)
                  .map((game) => {
                    const players = [...game.players.values()]
                      .sort((a, b) => a.localeCompare(b, "ru-RU"));

                    return `- ${game.name} — ${game.players.size} ${pluralizeRu(game.players.size, [
                      "участник",
                      "участника",
                      "участников"
                    ])}: ${formatParticipantList(players)}`;
                  })
              : ["Совпадений не найдено."]),
            ...(matchingDebugGames.length > 20 ? [`...и ещё ${matchingDebugGames.length - 20}`] : [])
          ]
        : []),
      ...(isDebug && skippedAccounts.length > 0
        ? [
            "",
            "Пропущенные аккаунты:",
            ...skippedAccounts
              .slice(0, 10)
              .map((account) => `- ${account.psnOnlineId} (${account.telegramLabel}): ${account.reason}`),
            ...(skippedAccounts.length > 10 ? [`...и ещё ${skippedAccounts.length - 10}`] : [])
          ]
        : [])
    ];

    await replyToCommand(ctx, lines.join("\n"));
  });

  bot.command("table", async (ctx) => {
    if (!ensureGroup(ctx.chat.type)) {
      await replyToCommand(ctx, "Эта команда работает только в группах.");
      return;
    }

    const users = await repository.listUsers(ctx.chat.id);
    if (users.length === 0) {
      await replyToCommand(ctx, "В этой группе пока нет привязанных PSN-профилей.");
      return;
    }

    try {
      const aggregatedPlayers = await Promise.all(users.map((user) => loadAggregatedPlayer(user)));

      const sorted = aggregatedPlayers
        .sort((a, b) => {
          if (b.level !== a.level) {
            return b.level - a.level;
          }

          return getTrophyWeight(b) - getTrophyWeight(a);
        })
        .map((player) =>
          formatLeaderboardRow(
            {
              telegramLabel: formatTelegramName(player.user),
              accounts: player.accounts,
              level: player.level,
              trophies: player.trophies
            },
            config.emojis
          )
        );

      const messages = chunkRichMessages([
        { text: `Таблица группы по PSN (${sorted.length}):`, entities: [] },
        ...sorted
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
      const message =
        error instanceof Error ? formatPsnError(error) : "Не удалось получить данные части профилей.";
      await replyToCommand(ctx, `Не получилось собрать таблицу: ${message}`);
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
