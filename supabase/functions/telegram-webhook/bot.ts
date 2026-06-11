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
import type { KnownChat, PendingTelegramAction } from "./repository.ts";
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

function isPrivateChat(chatType: string): boolean {
  return chatType === "private";
}

// Бот сделан для конкретного группового чата, но в личке тоже работает:
// там он показывает данные выбранного группового чата (см. resolveDmChat).
function isSupportedChat(chatType: string): boolean {
  return ensureGroup(chatType) || isPrivateChat(chatType);
}

function formatChatTitle(chat: KnownChat): string {
  const title = chat.title?.trim();
  return title && title.length > 0 ? title : `Чат ${chat.chatId}`;
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

// Inline mention of the actor as a leading text_mention entity. A ForceReply with
// selective:true is targeted at users mentioned in the prompt, so this keeps the
// forced reply scoped to the person who tapped the button in a group chat.
function buildActorMention(actor: TelegramActor): { text: string; entities: MessageEntity[] } {
  const name = getDisplayName(actor);
  return {
    text: name,
    entities: [
      {
        type: "text_mention",
        offset: 0,
        length: utf16Length(name),
        user: {
          id: actor.id,
          is_bot: false,
          first_name: actor.first_name,
          last_name: actor.last_name
        }
      }
    ]
  };
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

// Telegram pins a ForceReply's input_field_placeholder in the client's per-chat
// input state and gives the bot no "reply answered" signal, so the grey hint can
// stick (get cached) even after the prompt is consumed/cancelled/expired. The only
// way to drop it is to overwrite that state with a fresh reply markup: we send a
// blank carrier message carrying ReplyKeyboardRemove — scoped to the one user via
// selective + a reply to their own message — then delete the carrier (the client
// has already collapsed the input state by then). `aggressive` first re-renders the
// input with a placeholder-less force_reply for sticky clients (TelegramSwift#1103),
// then always ends on remove_keyboard so the input returns to a normal state.
// Refs: grammyjs/stateless-question; tdlib/telegram-bot-api#471.
async function clearForcedReplyPlaceholder(
  ctx: Context,
  targetMessageId: number | undefined,
  options: { aggressive?: boolean } = {}
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    return;
  }

  const replyParameters = targetMessageId !== undefined
    ? { message_id: targetMessageId, allow_sending_without_reply: true }
    : undefined;

  const sendReset = async (
    replyMarkup: { remove_keyboard: true; selective: true } | { force_reply: true; selective: true }
  ): Promise<void> => {
    try {
      const carrier = await ctx.api.sendMessage(chatId, "⠀", {
        reply_parameters: replyParameters,
        reply_markup: replyMarkup
      });
      await ctx.api.deleteMessage(chatId, carrier.message_id).catch(() => {});
    } catch (error) {
      console.warn(
        `[placeholder] reset failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  if (options.aggressive) {
    await sendReset({ force_reply: true, selective: true });
  }
  await sendReset({ remove_keyboard: true, selective: true });
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

function buildChatSelectCallbackData(ownerId: number, chatId: number): string {
  return `selchat:${ownerId}:${chatId}`;
}

function parseChatSelectCallbackData(value: string | undefined): { ownerId: number; chatId: number } | null {
  const match = /^selchat:(\d+):(-?\d+)$/.exec(value ?? "");
  if (!match) {
    return null;
  }

  return {
    ownerId: Number(match[1]),
    chatId: Number(match[2])
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

  // Состоит ли пользователь в чате прямо сейчас. Нужно, чтобы в личке не
  // предлагать (и не отдавать) данные чатов, к которым человек отношения не имеет.
  async function isUserInChat(chatId: number, userId: number): Promise<boolean> {
    try {
      const member = await bot.api.getChatMember(chatId, userId);
      if (member.status === "left" || member.status === "kicked") {
        return false;
      }
      if (member.status === "restricted") {
        return member.is_member === true;
      }
      return true;
    } catch (error) {
      console.warn(
        `[dm] getChatMember failed chat=${chatId} user=${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  // Чаты, по которым пользователь может смотреть данные в личке: известные боту
  // чаты, где пользователь сейчас состоит, плюс чаты с его привязками (там он
  // точно участник, даже если getChatMember недоступен).
  async function listSelectableChats(userId: number): Promise<KnownChat[]> {
    const [known, linkedChatIds] = await Promise.all([
      repository.listKnownChats(),
      repository.listUserChatIds(userId)
    ]);

    const candidates = new Map<number, KnownChat>();
    for (const chat of known) {
      candidates.set(chat.chatId, chat);
    }
    const linkedSet = new Set(linkedChatIds);
    for (const chatId of linkedChatIds) {
      if (!candidates.has(chatId)) {
        candidates.set(chatId, { chatId, title: null, type: "group" });
      }
    }

    const checked = await mapWithConcurrency([...candidates.values()], 4, async (chat) => {
      if (linkedSet.has(chat.chatId)) {
        return chat;
      }
      return (await isUserInChat(chat.chatId, userId)) ? chat : null;
    });

    return checked.filter((chat): chat is KnownChat => chat !== null);
  }

  async function promptChatSelection(
    ctx: TelegramActionContext,
    ownerId: number,
    chats: KnownChat[],
    header: string
  ): Promise<void> {
    const keyboard = new InlineKeyboard();
    for (const chat of chats) {
      keyboard.text(formatChatTitle(chat), buildChatSelectCallbackData(ownerId, chat.chatId)).row();
    }

    await replyToCommand(ctx, header, { reply_markup: keyboard });
  }

  // Определяет групповой чат, данные которого показывать в личке. Возвращает
  // chatId, либо null — если сообщение уже отправлено пользователю (нет общих
  // чатов / нужно выбрать из нескольких).
  async function resolveDmChat(ctx: TelegramActionContext, actor: TelegramActor): Promise<number | null> {
    const stored = await repository.getDmChatSelection(actor.id);
    if (stored !== null) {
      return stored;
    }

    const chats = await listSelectableChats(actor.id);
    if (chats.length === 0) {
      await replyToCommand(
        ctx,
        "Я пока не вижу ни одного общего с тобой чата. Добавь меня в нужный чат (или напиши там что-нибудь), потом возвращайся в личку."
      );
      return null;
    }

    if (chats.length === 1) {
      await repository.setDmChatSelection(actor.id, chats[0].chatId);
      return chats[0].chatId;
    }

    await promptChatSelection(
      ctx,
      actor.id,
      chats,
      "Выбери чат, данные которого показывать в личке:"
    );
    return null;
  }

  // Чат, с данными которого работает команда: сам групповой чат, либо выбранный
  // в личке. null означает, что пользователю уже отправлен ответ и обработку
  // нужно прекратить.
  async function resolveCommandChat(ctx: TelegramActionContext): Promise<number | null> {
    if (ensureGroup(ctx.chat.type)) {
      return ctx.chat.id;
    }

    if (!isPrivateChat(ctx.chat.type)) {
      await replyToCommand(ctx, "Бот работает в группах и в личке.");
      return null;
    }

    const actor = getActor(ctx);
    if (!actor) {
      await replyToCommand(ctx, "Не удалось определить отправителя команды.");
      return null;
    }

    return resolveDmChat(ctx, actor);
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

  async function requireActor(ctx: TelegramActionContext): Promise<TelegramActor | null> {
    const actor = getActor(ctx);
    if (!actor) {
      await replyToCommand(ctx, "Не удалось определить отправителя команды.");
      return null;
    }

    return actor;
  }

  async function sendActionMenu(ctx: TelegramActionContext): Promise<void> {
    const actor = await requireActor(ctx);
    if (!actor) {
      return;
    }

    // Убеждаемся, что есть чат данных (в личке это может вывести выбор чата);
    // если нет — resolveCommandChat уже ответил пользователю, меню не показываем.
    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
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

    if (action === "summary_psn") {
      // No verbose bot reply: just focus the user's input with a grey hint
      // ("Введите ник @Telegram или ник PSN") via ForceReply. The next text they
      // send is picked up by the pending-action flow and routed to handleSummary.
      const mention = buildActorMention(actor);
      await replyToCommand(ctx, `${mention.text}, чья сводка?`, {
        entities: mention.entities,
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: "Введите ник @Telegram или ник PSN"
        }
      });
      return;
    }

    const hints: Record<PendingTelegramAction, string> = {
      link: "Пришли PSN Online ID, который нужно привязать.",
      summary_psn: "Пришли @telegram участника чата или PSN Online ID. Для своей сводки можно просто нажать «Моя сводка».",
      default: "Пришли PSN Online ID из твоих привязок, который сделать default.",
      unlink: "Пришли PSN Online ID для удаления или /cancel, если передумал."
    };

    await replyToCommand(ctx, `${PENDING_ACTION_LABELS[action]}\n${hints[action]}\n\nОтмена: /cancel`);
  }

  async function handleLink(ctx: TelegramActionContext, chatId: number, actor: TelegramActor, onlineId: string): Promise<void> {
    const existingOwner = await repository.getAccountOwner(chatId, onlineId);
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
      const canonicalOwner = await repository.getAccountOwner(chatId, summary.onlineId);

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
        chatId,
        userId: actor.id,
        username: actor.username ?? null,
        displayName: getDisplayName(actor),
        psnOnlineId: summary.onlineId
      });

      const aggregated = await loadAggregatedPlayer({
        chatId,
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

  async function handleMe(ctx: TelegramActionContext, chatId: number, actor: TelegramActor): Promise<void> {
    const accounts = await repository.listAccountsByUser(chatId, actor.id);
    if (accounts.length === 0) {
      await replyToCommand(ctx, "У тебя пока нет привязок. Используй /link <online-id> или /menu.");
      return;
    }

    await repository.syncUserMetadata({
      chatId,
      userId: actor.id,
      username: actor.username ?? null,
      displayName: getDisplayName(actor)
    });

    await replyToCommand(
      ctx,
      `Твои аккаунты: ${accounts.map((account) => account.psnOnlineId).join(", ")}`
    );
  }

  async function handleSummary(ctx: TelegramActionContext, chatId: number, actor: TelegramActor | null, targetArg: string | null): Promise<void> {
    const responseMode = await repository.getResponseMode(chatId);

    if (targetArg && !isTelegramHandle(targetArg)) {
      try {
        const summary = await psnService.getSummaryByOnlineId(targetArg);

        if (responseMode === "text") {
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
          return;
        }

        const mockPlayer: AggregatedPlayer = {
          user: {
            userId: 0,
            chatId,
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

    const targetUser = await resolveTargetUser(chatId, actor, targetArg);

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

      if (responseMode === "text") {
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
        return;
      }

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

  async function handleDefault(ctx: TelegramActionContext, chatId: number, actor: TelegramActor, onlineId: string): Promise<void> {
    const accounts = await repository.listAccountsByUser(chatId, actor.id);
    const match = accounts.find((account) => account.psnOnlineId.toLowerCase() === onlineId.toLowerCase());

    if (!match) {
      await replyToCommand(ctx, `У тебя нет привязки к ${onlineId}.`);
      return;
    }

    await repository.setDefaultAccount(chatId, actor.id, match.psnOnlineId);
    await replyToCommand(ctx, `Приоритетный аккаунт для summary: ${match.psnOnlineId}`);
  }

  async function handleRegion(ctx: TelegramActionContext, chatId: number, actor: TelegramActor | null, targetArg: string | null): Promise<void> {
    const targetUser = await resolveTargetUser(chatId, actor, targetArg);

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

  async function handlePlats(ctx: TelegramActionContext, chatId: number, actor: TelegramActor | null, targetArg: string | null): Promise<void> {
    const targetUser = await resolveTargetUser(chatId, actor, targetArg);

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
      const accounts = await repository.listAccountsByUser(chatId, targetUser.userId);
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

  async function handleUnlink(ctx: TelegramActionContext, chatId: number, actor: TelegramActor, onlineId: string | null): Promise<void> {
    const deleted = await repository.deleteLinks(chatId, actor.id, onlineId ?? undefined);

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

  async function handlePopular(ctx: TelegramActionContext, chatId: number, commandArgs: string[] = []): Promise<void> {
    const isDebug = commandArgs[0]?.toLowerCase() === "debug";
    const debugSearch = isDebug ? commandArgs.slice(1).join(" ").trim() : "";
    const normalizedDebugSearch = normalizeSearchText(debugSearch);
    const users = await repository.listUsers(chatId);
    if (users.length === 0) {
      await replyToCommand(ctx, "В этой группе пока нет привязанных PSN-профилей.");
      return;
    }

    const accountsByUser = await Promise.all(
      users.map(async (user) => ({
        user,
        accounts: await repository.listAccountsByUser(chatId, user.userId)
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

    const responseMode = await repository.getResponseMode(chatId);
    if (!isDebug && responseMode === "image" && ctx.replyWithPhoto) {
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

  async function handleTable(ctx: TelegramActionContext, chatId: number): Promise<void> {
    const users = await repository.listUsers(chatId);
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

      const responseMode = await repository.getResponseMode(chatId);
      if (responseMode === "text") {
        const rows = sorted.map((player) =>
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
          { text: `Таблица группы по PSN (${rows.length}):`, entities: [] },
          ...rows
        ]);
        for (const [index, message] of messages.entries()) {
          await ctx.reply(
            message.text,
            index === 0 && ctx.msg
              ? {
                  entities: message.entities,
                  reply_parameters: { message_id: ctx.msg.message_id }
                }
              : { entities: message.entities }
          );
        }
        return;
      }

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

  async function handleSwitchMode(ctx: TelegramActionContext, chatId: number): Promise<void> {
    const current = await repository.getResponseMode(chatId);
    const next = current === "image" ? "text" : "image";
    await repository.setResponseMode(chatId, next);
    await replyToCommand(
      ctx,
      next === "text"
        ? "Режим ответов: 📝 текст. Сводка, таблица и популярные теперь приходят текстом."
        : "Режим ответов: 🖼 картинка. Сводка, таблица и популярные снова приходят картинками."
    );
  }

  async function sendHelp(ctx: TelegramActionContext) {
    const actor = getActor(ctx);
    const inPrivate = isPrivateChat(ctx.chat.type);
    const canShowMenu = actor && isSupportedChat(ctx.chat.type);

    await replyToCommand(
      ctx,
      [
        "Я бот для привязки участников чата к нескольким PSN-аккаунтам.",
        "",
        "Основной вход: /menu",
        "В меню есть кнопки для сводки, таблицы, популярных игр, платин, регионов и действий с PSN ID.",
        ...(inPrivate
          ? [
              "",
              "В личке я показываю данные группового чата. Выбрать или сменить чат: /chat"
            ]
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
        "/switch_mode — переключить ответы бота между картинкой и текстом",
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

  // Запоминаем групповые чаты, чтобы в личке предлагать выбор по понятным
  // названиям (см. /chat и resolveDmChat). Личные чаты не сохраняем.
  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    if (chat && ensureGroup(chat.type)) {
      try {
        await repository.rememberChat({
          chatId: chat.id,
          title: "title" in chat ? (chat.title ?? null) : null,
          type: chat.type
        });
      } catch (error) {
        console.warn(
          `[chats] rememberChat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await next();
  });

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text?.trim();
    if (
      text?.startsWith("/") &&
      !text.startsWith("/cancel") &&
      ctx.chat &&
      isSupportedChat(ctx.chat.type) &&
      ctx.from
    ) {
      const cleared = await repository.clearPendingAction(ctx.chat.id, ctx.from.id);
      if (cleared === "summary_psn") {
        await clearForcedReplyPlaceholder(ctx, ctx.message?.message_id);
      }
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
    if (!isSupportedChat(ctx.chat.type)) {
      return;
    }

    const actor = await requireActor(ctx);
    if (!actor) {
      return;
    }

    const cleared = await repository.clearPendingAction(ctx.chat.id, actor.id);
    if (cleared === "summary_psn") {
      await clearForcedReplyPlaceholder(ctx, ctx.msg?.message_id);
    }
    await replyToCommand(ctx, "Ок, отменил ожидаемое действие.");
  });

  // Скрытая дебаг-команда (нигде не анонсируется): форсированно сбрасывает
  // залипшую серую подсказку из поля ввода (input_field_placeholder от ForceReply,
  // которую Telegram кеширует на клиенте). Адресуется только вызвавшему и убирает
  // за собой технические сообщения, включая саму команду.
  bot.command("clearhint", async (ctx) => {
    if (!isSupportedChat(ctx.chat.type)) {
      return;
    }

    const actor = await requireActor(ctx);
    if (!actor) {
      return;
    }

    const commandMessageId = ctx.msg?.message_id;
    await clearForcedReplyPlaceholder(ctx, commandMessageId, { aggressive: true });
    await repository.clearPendingAction(ctx.chat.id, actor.id);

    if (commandMessageId !== undefined) {
      await ctx.api.deleteMessage(ctx.chat.id, commandMessageId).catch(() => {});
    }
  });

  // Скрытая команда (нигде не анонсируется в групповой справке): в личке
  // выбрать групповой чат, данные которого показывать. Нужна, когда бот добавлен
  // в несколько чатов и иначе нельзя понять, по какому отдавать данные.
  bot.command("chat", async (ctx) => {
    const actionCtx = ctx as unknown as TelegramActionContext;

    if (ensureGroup(ctx.chat.type)) {
      await replyToCommand(
        actionCtx,
        "В группе я и так работаю с этим чатом. Команда /chat нужна только в личке."
      );
      return;
    }

    if (!isPrivateChat(ctx.chat.type)) {
      return;
    }

    const actor = getActor(ctx);
    if (!actor) {
      await replyToCommand(actionCtx, "Не удалось определить отправителя команды.");
      return;
    }

    const chats = await listSelectableChats(actor.id);
    if (chats.length === 0) {
      await replyToCommand(
        actionCtx,
        "Я пока не вижу ни одного общего с тобой чата. Добавь меня в нужный чат (или напиши там что-нибудь), потом возвращайся в личку."
      );
      return;
    }

    const current = await repository.getDmChatSelection(actor.id);
    const currentChat = current !== null ? chats.find((chat) => chat.chatId === current) : undefined;
    const header = currentChat
      ? `Сейчас активен чат: ${formatChatTitle(currentChat)}\nВыбери другой, если нужно:`
      : "Выбери чат, данные которого показывать в личке:";

    await promptChatSelection(actionCtx, actor.id, chats, header);
  });

  bot.command("link", async (ctx) => {
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

    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
      return;
    }

    await handleLink(ctx, chatId, actor, onlineId);
  });

  bot.command("me", async (ctx) => {
    const actor = getActor(ctx);
    if (!actor) {
      await replyToCommand(ctx, "Не удалось определить отправителя команды.");
      return;
    }

    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
      return;
    }

    await handleMe(ctx, chatId, actor);
  });

  bot.command("summary", async (ctx) => {
    const actor = getActor(ctx);
    const targetArg = getCommandArg(ctx.message?.text);

    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
      return;
    }

    await handleSummary(ctx, chatId, actor, targetArg);
  });

  bot.command("default", async (ctx) => {
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

    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
      return;
    }

    await handleDefault(ctx, chatId, actor, onlineId);
  });

  bot.command("region", async (ctx) => {
    const actor = getActor(ctx);
    const targetArg = getCommandArg(ctx.message?.text);

    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
      return;
    }

    await handleRegion(ctx, chatId, actor, targetArg);
  });

  bot.command("plats", async (ctx) => {
    const actor = getActor(ctx);
    const targetArg = getCommandArg(ctx.message?.text);

    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
      return;
    }

    await handlePlats(ctx, chatId, actor, targetArg);
  });

  bot.command("unlink", async (ctx) => {
    const actor = getActor(ctx);
    if (!actor) {
      await replyToCommand(ctx, "Не удалось определить отправителя команды.");
      return;
    }

    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
      return;
    }

    await handleUnlink(ctx, chatId, actor, getCommandArg(ctx.message?.text));
  });

  bot.command("popular", async (ctx) => {
    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
      return;
    }

    await handlePopular(ctx, chatId, getCommandArgs(ctx.message?.text));
  });

  bot.command("table", async (ctx) => {
    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
      return;
    }

    await handleTable(ctx, chatId);
  });

  bot.command("switch_mode", async (ctx) => {
    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
      return;
    }

    await handleSwitchMode(ctx, chatId);
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

    if (!ctx.chat || !isSupportedChat(ctx.chat.type)) {
      await replyToCommand(ctx, "Бот работает в группах и в личке.");
      return;
    }

    const actionCtx = ctx as unknown as TelegramActionContext;
    const chatId = await resolveCommandChat(actionCtx);
    if (chatId === null) {
      return;
    }

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
          await handleSummary(actionCtx, chatId, actor, null);
          return;
        case "me":
          await handleMe(actionCtx, chatId, actor);
          return;
        case "table":
          await handleTable(actionCtx, chatId);
          return;
        case "popular":
          await handlePopular(actionCtx, chatId);
          return;
        case "plats":
          await handlePlats(actionCtx, chatId, actor, null);
          return;
        case "region":
          await handleRegion(actionCtx, chatId, actor, null);
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

  bot.callbackQuery(/^selchat:/, async (ctx) => {
    const parsed = parseChatSelectCallbackData(ctx.callbackQuery.data);
    if (!parsed) {
      await safeAnswerCallbackQuery(ctx, "Не понял выбор чата.");
      return;
    }

    const actor = getActor(ctx);
    if (!actor) {
      await safeAnswerCallbackQuery(ctx, "Не удалось определить отправителя.");
      return;
    }

    if (actor.id !== parsed.ownerId) {
      await safeAnswerCallbackQuery(ctx, "Это выбор другого пользователя. Отправь /chat");
      return;
    }

    await repository.setDmChatSelection(actor.id, parsed.chatId);

    const known = await repository.listKnownChats();
    const chosen = known.find((chat) => chat.chatId === parsed.chatId);
    const title = chosen ? formatChatTitle(chosen) : `Чат ${parsed.chatId}`;

    await safeAnswerCallbackQuery(ctx, `Выбран чат: ${title}`);

    // Обновляем текст, но сохраняем кнопки: можно сразу переключиться на другой чат.
    try {
      await ctx.editMessageText(`Активный чат: ${title}\n\nМожно переключиться кнопкой ниже или открыть /menu.`, {
        reply_markup: ctx.callbackQuery.message?.reply_markup
      });
    } catch {
      // Сообщение могло устареть или не поддерживать редактирование — тост уже показан.
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    if (text.startsWith("/")) {
      return;
    }

    if (!isSupportedChat(ctx.chat.type)) {
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
      if (pending.action === "summary_psn") {
        await clearForcedReplyPlaceholder(ctx, ctx.message.message_id);
      }
      await replyToCommand(ctx, "Ожидаемое действие истекло. Открой /menu и попробуй ещё раз.");
      return;
    }

    await repository.clearPendingAction(ctx.chat.id, actor.id);
    if (pending.action === "summary_psn") {
      await clearForcedReplyPlaceholder(ctx, ctx.message.message_id);
    }

    const chatId = await resolveCommandChat(ctx);
    if (chatId === null) {
      return;
    }

    switch (pending.action) {
      case "link":
        await handleLink(ctx, chatId, actor, text);
        return;
      case "summary_psn":
        await handleSummary(ctx, chatId, actor, text);
        return;
      case "default":
        await handleDefault(ctx, chatId, actor, text);
        return;
      case "unlink":
        await handleUnlink(ctx, chatId, actor, text);
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
