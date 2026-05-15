import { Bot, GrammyError, HttpError } from "grammy";
import type { MessageEntity } from "grammy/types";
import { getConfig } from "./config.js";
import { LinkRepository, type LinkedAccount, type LinkedUser } from "./db.js";
import {
  formatLeaderboardRow,
  formatPlatinumRow,
  formatSummary,
  getFlagEmoji,
  type AccountLabel
} from "./format.js";
import { PsnPrivateProfileError, PsnService, type PsnPlatinumTitle, type PsnSummary } from "./psn.js";

const config = getConfig();
const repository = new LinkRepository(config.databasePath);
const psnService = new PsnService(config.psnNpsso);
const bot = new Bot(config.botToken);

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

  const users = repository.listUsers(chatId);
  return users.find((user) => user.userId === actor.id) ?? null;
}

function isTelegramHandle(value: string | null): boolean {
  return Boolean(value && value.trim().startsWith("@"));
}

async function loadAggregatedPlayer(user: LinkedUser): Promise<AggregatedPlayer> {
  const accountLinks = repository.listAccountsByUser(user.chatId, user.userId);
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
      "/default <online-id> — выбрать приоритетный аккаунт для summary",
      "/table — общая таблица игроков группы",
      "/plats [@telegram] — список платин игрока по всем аккаунтам",
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

  const existingOwner = repository.getAccountOwner(ctx.chat.id, onlineId);
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
    const canonicalOwner = repository.getAccountOwner(ctx.chat.id, summary.onlineId);

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

    repository.addLink({
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

  const accounts = repository.listAccountsByUser(ctx.chat.id, actor.id);
  if (accounts.length === 0) {
    await replyToCommand(ctx, "У тебя пока нет привязок. Используй /link <online-id>.");
    return;
  }

  repository.syncUserMetadata({
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

  const accounts = repository.listAccountsByUser(ctx.chat.id, actor.id);
  const match = accounts.find((account) => account.psnOnlineId.toLowerCase() === onlineId.toLowerCase());

  if (!match) {
    await replyToCommand(ctx, `У тебя нет привязки к ${onlineId}.`);
    return;
  }

  repository.setDefaultAccount(ctx.chat.id, actor.id, match.psnOnlineId);
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
    const accounts = repository.listAccountsByUser(ctx.chat.id, targetUser.userId);
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
  const deleted = repository.deleteLinks(ctx.chat.id, actor.id, onlineId ?? undefined);

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

bot.command("table", async (ctx) => {
  if (!ensureGroup(ctx.chat.type)) {
    await replyToCommand(ctx, "Эта команда работает только в группах.");
    return;
  }

  const users = repository.listUsers(ctx.chat.id);
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

await bot.init();
console.log("Bot initialized");
await bot.start();
