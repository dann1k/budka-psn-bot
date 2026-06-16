// Фоновый детектор новых платин. Раз в N минут (см. features.platinumWatcher)
// обходит все залинкованные PSN-аккаунты, сравнивает набор платин с сохранённым
// снапшотом (ledger psn_platinum_seen) и постит уведомление в чат(ы), где аккаунт
// привязан, на каждую новую платину.
//
// Ключевые свойства:
//   • Снапшот по АККАУНТУ (нормализованный online id), не по чату: один аккаунт в
//     N чатах опрашивается один раз, анонс — веером во все чаты.
//   • baseline без спама: при первом обходе аккаунта все текущие платины пишутся
//     как уже виденные/анонсированные, исторические НЕ постятся.
//   • Идемпотентность: ledger-строка с announced_at (null = ждёт отправки). Запись
//     события и его доставка разнесены по фазам, поэтому анонс переживает рестарт
//     (persist → announce), а повторов нет.
//
// Запускается только в self-hosted рантайме (server/main.ts), один процесс — гонок
// между обходами нет (sweep вызывается под in-process флагом «sweep идёт»).
import { type Api, InputFile } from "npm:grammy@1.41.1/web";
import type {
  LinkedPsnAccount,
  LinkRepository,
  PendingPlatinum,
  PlatinumChatTarget,
  PlatinumWatchRow
} from "./repository.ts";
import {
  PsnPrivateProfileError,
  type PsnPlatinumPoll,
  type PsnPolledPlatinum,
  type PsnService,
  type PsnSummary
} from "./psn.ts";
import { renderPlatinumCard } from "./renderer.tsx";
import { buildPlatinumUnlockedHtml, sendRich } from "./rich.ts";
import { texts } from "../../../config/texts.ts";
import type { EmojiConfig } from "./types.ts";

// Чистый дифф: какие из текущих платин ещё не отмечены как «виденные». Вынесен
// отдельно, чтобы покрыть тестом без сети/БД (см. tests/platinum-watch.test.ts).
export function selectFreshPlatinums(
  seen: ReadonlySet<string>,
  current: readonly PsnPolledPlatinum[]
): PsnPolledPlatinum[] {
  return current.filter((platinum) => !seen.has(platinum.npCommunicationId));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Небольшой зазор между аккаунтами, чтобы не делать всплеск запросов к PSN.
const ACCOUNT_GAP_MS = 150;
// Приватный профиль виден не будет ещё долго — долгий бэк-офф.
const PRIVATE_BACKOFF_MS = 6 * 60 * 60_000;
// Потолок экспоненциального бэк-оффа для временных ошибок (минуты).
const MAX_TRANSIENT_BACKOFF_MIN = 60;

export class PlatinumWatcher {
  constructor(
    private readonly api: Api,
    private readonly repository: LinkRepository,
    private readonly psnService: PsnService,
    private readonly emojis: EmojiConfig
  ) {}

  async sweep(): Promise<void> {
    const accounts = await this.repository.listDistinctLinkedPsnAccounts();
    if (accounts.length === 0) {
      return;
    }

    console.log(`[psn-platinum] sweep start: ${accounts.length} account(s)`);

    let fresh = 0;
    for (const account of accounts) {
      fresh += await this.pollAccount(account);
      await sleep(ACCOUNT_GAP_MS);
    }

    const announced = await this.announcePending();
    console.log(`[psn-platinum] sweep done: ${fresh} new platinum(s), ${announced} announced`);
  }

  // Опрашивает один аккаунт и записывает события в очередь. Возвращает число
  // новых платин (для лога). Ошибки не пробрасывает — гасит в бэк-офф.
  private async pollAccount(account: LinkedPsnAccount): Promise<number> {
    const now = Date.now();
    const state = await this.repository.getPlatinumWatch(account.normalized);

    if (state?.disabledUntil && Date.parse(state.disabledUntil) > now) {
      return 0; // в бэк-оффе после ошибки/приватности
    }

    let poll: PsnPlatinumPoll;
    try {
      poll = await this.psnService.getEarnedPlatinumsForPoll(
        account.onlineId,
        state?.accountId ?? null
      );
    } catch (error) {
      await this.recordPollError(account, state, error);
      return 0;
    }

    const nowIso = new Date().toISOString();
    const baseRow: PlatinumWatchRow = {
      normalized: account.normalized,
      accountId: poll.accountId,
      baselinedAt: state?.baselinedAt ?? null,
      lastPolledAt: nowIso,
      lastActivityAt: poll.maxActivityAt,
      consecutiveErrors: 0,
      disabledUntil: null
    };

    // Первый обход аккаунта: засеваем все текущие платины как уже виденные и
    // анонсированные (announced_at = now) — исторические платины НЕ спамим.
    if (!state || !state.baselinedAt) {
      await this.repository.insertSeenPlatinums(account.normalized, poll.platinums, nowIso);
      await this.repository.upsertPlatinumWatch({ ...baseRow, baselinedAt: nowIso });
      console.log(
        `[psn-platinum] baseline ${account.onlineId}: ${poll.platinums.length} platinum(s) suppressed`
      );
      return 0;
    }

    const seen = await this.repository.getSeenPlatinumIds(account.normalized);
    const fresh = selectFreshPlatinums(seen, poll.platinums);

    if (fresh.length > 0) {
      // announced_at = null → подхватит фаза доставки.
      await this.repository.insertSeenPlatinums(account.normalized, fresh, null);
      console.log(`[psn-platinum] ${account.onlineId}: ${fresh.length} new platinum(s)`);
    }

    await this.repository.upsertPlatinumWatch(baseRow);
    return fresh.length;
  }

  private async recordPollError(
    account: LinkedPsnAccount,
    state: PlatinumWatchRow | null,
    error: unknown
  ): Promise<void> {
    const errors = (state?.consecutiveErrors ?? 0) + 1;
    const isPrivate = error instanceof PsnPrivateProfileError;
    const backoffMs = isPrivate
      ? PRIVATE_BACKOFF_MS
      : Math.min(2 ** errors, MAX_TRANSIENT_BACKOFF_MIN) * 60_000;

    await this.repository.upsertPlatinumWatch({
      normalized: account.normalized,
      accountId: state?.accountId ?? null,
      baselinedAt: state?.baselinedAt ?? null,
      lastPolledAt: state?.lastPolledAt ?? null,
      lastActivityAt: state?.lastActivityAt ?? null,
      consecutiveErrors: errors,
      disabledUntil: new Date(Date.now() + backoffMs).toISOString()
    });

    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[psn-platinum] poll failed for ${account.onlineId} (#${errors}, backoff ${Math.round(backoffMs / 60_000)}m): ${reason}`
    );
  }

  // Фаза доставки. Отдельно от опроса, чтобы пережить рестарт: строки с
  // announced_at = null досылаются на следующем sweep. Возвращает число
  // фактически отправленных сообщений.
  private async announcePending(): Promise<number> {
    const pending = await this.repository.listPendingPlatinumAnnouncements();
    if (pending.length === 0) {
      return 0;
    }

    const byAccount = new Map<string, PendingPlatinum[]>();
    for (const platinum of pending) {
      const bucket = byAccount.get(platinum.normalized);
      if (bucket) {
        bucket.push(platinum);
      } else {
        byAccount.set(platinum.normalized, [platinum]);
      }
    }

    let delivered = 0;
    for (const [normalized, platinums] of byAccount.entries()) {
      delivered += await this.announceAccount(normalized, platinums);
    }

    return delivered;
  }

  private async announceAccount(normalized: string, platinums: PendingPlatinum[]): Promise<number> {
    const chats = await this.repository.listChatsForPsnAccount(normalized);

    // Аккаунт отвязали после опроса — чистим очередь, чтобы не висела вечно.
    if (chats.length === 0) {
      await this.repository.markPlatinumsAnnounced(
        normalized,
        platinums.map((platinum) => platinum.npCommunicationId)
      );
      return 0;
    }

    const onlineId = chats[0].psnOnlineId;
    // Сводку (аватар/регион/plus) тянем один раз на аккаунт — для карточки. Профиль
    // мог стать приватным между опросом и анонсом → деградируем без аватара/региона.
    let summary: PsnSummary | null = null;
    try {
      summary = await this.psnService.getSummaryByOnlineId(onlineId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[psn-platinum] summary unavailable for ${onlineId}: ${reason}`);
    }

    let delivered = 0;
    for (const chat of chats) {
      let enabled = true;
      try {
        enabled = await this.repository.isPlatinumAnnounceEnabled(chat.chatId);
      } catch {
        enabled = true; // настройка недоступна → по умолчанию анонсим
      }
      if (!enabled) {
        continue;
      }

      let mode: "image" | "text" = "image";
      try {
        mode = await this.repository.getResponseMode(chat.chatId);
      } catch {
        mode = "image";
      }

      for (const platinum of platinums) {
        try {
          await this.sendOne(chat, onlineId, summary, platinum, mode);
          delivered += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(
            `[psn-platinum] send failed to chat ${chat.chatId} (${platinum.titleName}): ${reason}`
          );
        }
      }
    }

    // Помечаем анонсированными в любом случае (best-effort доставка): даже если
    // часть чатов отключила анонс или временно недоступна, очередь не зацикливаем.
    await this.repository.markPlatinumsAnnounced(
      normalized,
      platinums.map((platinum) => platinum.npCommunicationId)
    );

    return delivered;
  }

  private async sendOne(
    chat: PlatinumChatTarget,
    onlineId: string,
    summary: PsnSummary | null,
    platinum: PendingPlatinum,
    mode: "image" | "text"
  ): Promise<void> {
    const ownerLabel = chat.username ? `@${chat.username}` : chat.displayName;
    const displayOnlineId = summary?.onlineId ?? onlineId;

    if (mode === "image") {
      try {
        const png = await renderPlatinumCard({
          onlineId: displayOnlineId,
          displayName: chat.displayName,
          username: chat.username,
          avatarUrl: summary?.avatarUrl ?? null,
          hasPlus: summary?.hasPlus ?? false,
          regionCode: summary?.region?.code ?? null,
          gameName: platinum.titleName,
          gameIconUrl: platinum.iconUrl,
          platform: platinum.platform
        });

        await this.api.sendPhoto(
          chat.chatId,
          new InputFile(png, `platinum_${platinum.npCommunicationId}.png`),
          { caption: texts.platinumWatch.caption(ownerLabel, platinum.titleName) }
        );
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[psn-platinum] card render/send failed, falling back to text: ${reason}`);
      }
    }

    const html = buildPlatinumUnlockedHtml(
      {
        ownerLabel,
        onlineId: displayOnlineId,
        titleName: platinum.titleName,
        platform: platinum.platform
      },
      this.emojis
    );

    try {
      await sendRich(this.api, chat.chatId, html);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[psn-platinum] rich send failed, plain fallback: ${reason}`);
      await this.api.sendMessage(
        chat.chatId,
        texts.platinumWatch.plain(ownerLabel, platinum.titleName, platinum.platform)
      );
    }
  }
}
