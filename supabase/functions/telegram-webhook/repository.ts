import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { LinkedAccount, LinkedUser } from "./types.ts";

export type PendingTelegramAction = "link" | "summary_psn" | "default" | "unlink";

export type ResponseMode = "image" | "text";

export type KnownChat = {
  chatId: number;
  title: string | null;
  type: string;
};

type TelegramChatRow = {
  chat_id: number | string;
  title: string | null;
  type: string;
};

type LinkedAccountRow = {
  chat_id: number | string;
  user_id: number | string;
  username: string | null;
  display_name: string;
  psn_online_id: string;
  linked_at: string;
};

type UserPreferenceRow = {
  chat_id: number | string;
  user_id: number | string;
  default_psn_online_id: string | null;
};

type PendingActionRow = {
  chat_id: number | string;
  user_id: number | string;
  action: PendingTelegramAction;
  created_at: string;
  expires_at: string;
};

function toLinkedAccount(row: LinkedAccountRow): LinkedAccount {
  return {
    chatId: Number(row.chat_id),
    userId: Number(row.user_id),
    username: row.username,
    displayName: row.display_name,
    psnOnlineId: row.psn_online_id,
    linkedAt: row.linked_at
  };
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

function assertNoError(error: { message: string } | null, action: string): void {
  if (error) {
    throw new Error(`${action}: ${error.message}`);
  }
}

export class LinkRepository {
  private readonly supabase: SupabaseClient;

  constructor(supabaseUrl: string, secretKey: string) {
    this.supabase = createClient(supabaseUrl, secretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  }

  async addLink(input: {
    chatId: number;
    userId: number;
    username: string | null;
    displayName: string;
    psnOnlineId: string;
  }): Promise<void> {
    const { error } = await this.supabase
      .from("linked_accounts")
      .upsert(
        {
          chat_id: input.chatId,
          user_id: input.userId,
          username: input.username,
          display_name: input.displayName,
          psn_online_id: input.psnOnlineId
        },
        {
          onConflict: "chat_id,user_id,psn_online_id"
        }
      );

    assertNoError(error, "Не получилось сохранить привязку");
  }

  async syncUserMetadata(input: {
    chatId: number;
    userId: number;
    username: string | null;
    displayName: string;
  }): Promise<void> {
    const { error } = await this.supabase
      .from("linked_accounts")
      .update({
        username: input.username,
        display_name: input.displayName
      })
      .eq("chat_id", input.chatId)
      .eq("user_id", input.userId);

    assertNoError(error, "Не получилось обновить Telegram-данные пользователя");
  }

  async listAccountsByUser(chatId: number, userId: number): Promise<LinkedAccount[]> {
    const { data, error } = await this.supabase
      .from("linked_accounts")
      .select("chat_id,user_id,username,display_name,psn_online_id,linked_at")
      .eq("chat_id", chatId)
      .eq("user_id", userId)
      .order("linked_at", { ascending: true });

    assertNoError(error, "Не получилось получить привязки пользователя");
    return ((data ?? []) as LinkedAccountRow[]).map(toLinkedAccount);
  }

  async getAccountOwner(chatId: number, psnOnlineId: string): Promise<LinkedAccount | null> {
    const { data, error } = await this.supabase
      .from("linked_accounts")
      .select("chat_id,user_id,username,display_name,psn_online_id,linked_at")
      .eq("chat_id", chatId)
      .eq("psn_online_id_normalized", normalizeLookup(psnOnlineId))
      .maybeSingle();

    assertNoError(error, "Не получилось проверить владельца PSN-профиля");
    return data ? toLinkedAccount(data as LinkedAccountRow) : null;
  }

  async listUsers(chatId: number): Promise<LinkedUser[]> {
    const [{ data: accounts, error: accountsError }, { data: preferences, error: preferencesError }] =
      await Promise.all([
        this.supabase
          .from("linked_accounts")
          .select("chat_id,user_id,username,display_name,psn_online_id,linked_at")
          .eq("chat_id", chatId)
          .order("linked_at", { ascending: true }),
        this.supabase
          .from("user_preferences")
          .select("chat_id,user_id,default_psn_online_id")
          .eq("chat_id", chatId)
      ]);

    assertNoError(accountsError, "Не получилось получить пользователей чата");
    assertNoError(preferencesError, "Не получилось получить настройки пользователей");

    const defaultByUser = new Map<number, string | null>();
    for (const preference of (preferences ?? []) as UserPreferenceRow[]) {
      defaultByUser.set(Number(preference.user_id), preference.default_psn_online_id);
    }

    const users = new Map<number, LinkedUser>();
    for (const row of (accounts ?? []) as LinkedAccountRow[]) {
      const userId = Number(row.user_id);
      if (users.has(userId)) {
        continue;
      }

      users.set(userId, {
        chatId: Number(row.chat_id),
        userId,
        username: row.username,
        displayName: row.display_name,
        defaultPsnOnlineId: defaultByUser.get(userId) ?? null
      });
    }

    return [...users.values()];
  }

  async findUserByUsername(chatId: number, username: string): Promise<LinkedUser | null> {
    const normalized = normalizeLookup(username.replace(/^@/, ""));
    const { data: account, error: accountError } = await this.supabase
      .from("linked_accounts")
      .select("chat_id,user_id,username,display_name,psn_online_id,linked_at")
      .eq("chat_id", chatId)
      .eq("username_normalized", normalized)
      .order("linked_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    assertNoError(accountError, "Не получилось найти пользователя по Telegram username");
    if (!account) {
      return null;
    }

    const row = account as LinkedAccountRow;
    const { data: preference, error: preferenceError } = await this.supabase
      .from("user_preferences")
      .select("chat_id,user_id,default_psn_online_id")
      .eq("chat_id", chatId)
      .eq("user_id", row.user_id)
      .maybeSingle();

    assertNoError(preferenceError, "Не получилось получить настройки пользователя");

    return {
      chatId: Number(row.chat_id),
      userId: Number(row.user_id),
      username: row.username,
      displayName: row.display_name,
      defaultPsnOnlineId: preference
        ? (preference as UserPreferenceRow).default_psn_online_id
        : null
    };
  }

  async deleteLinks(chatId: number, userId: number, psnOnlineId?: string): Promise<number> {
    if (psnOnlineId) {
      const { count, error } = await this.supabase
        .from("linked_accounts")
        .delete({ count: "exact" })
        .eq("chat_id", chatId)
        .eq("user_id", userId)
        .eq("psn_online_id_normalized", normalizeLookup(psnOnlineId));

      assertNoError(error, "Не получилось удалить привязку");

      const { error: preferenceError } = await this.supabase
        .from("user_preferences")
        .update({ default_psn_online_id: null })
        .eq("chat_id", chatId)
        .eq("user_id", userId)
        .eq("default_psn_online_id_normalized", normalizeLookup(psnOnlineId));

      assertNoError(preferenceError, "Не получилось сбросить default-аккаунт");
      return count ?? 0;
    }

    const { count, error } = await this.supabase
      .from("linked_accounts")
      .delete({ count: "exact" })
      .eq("chat_id", chatId)
      .eq("user_id", userId);

    assertNoError(error, "Не получилось удалить привязки пользователя");

    const { error: preferenceError } = await this.supabase
      .from("user_preferences")
      .delete()
      .eq("chat_id", chatId)
      .eq("user_id", userId);

    assertNoError(preferenceError, "Не получилось удалить настройки пользователя");
    return count ?? 0;
  }

  async setDefaultAccount(chatId: number, userId: number, psnOnlineId: string): Promise<void> {
    const { error } = await this.supabase
      .from("user_preferences")
      .upsert(
        {
          chat_id: chatId,
          user_id: userId,
          default_psn_online_id: psnOnlineId
        },
        {
          onConflict: "chat_id,user_id"
        }
      );

    assertNoError(error, "Не получилось сохранить default-аккаунт");
  }

  async setPendingAction(chatId: number, userId: number, action: PendingTelegramAction): Promise<void> {
    const { error } = await this.supabase
      .from("telegram_pending_actions")
      .upsert(
        {
          chat_id: chatId,
          user_id: userId,
          action,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString()
        },
        {
          onConflict: "chat_id,user_id"
        }
      );

    assertNoError(error, "Не получилось сохранить ожидаемое действие");
  }

  async getPendingAction(chatId: number, userId: number): Promise<PendingActionRow | null> {
    const { data, error } = await this.supabase
      .from("telegram_pending_actions")
      .select("chat_id,user_id,action,created_at,expires_at")
      .eq("chat_id", chatId)
      .eq("user_id", userId)
      .maybeSingle();

    assertNoError(error, "Не получилось получить ожидаемое действие");
    return data ? (data as PendingActionRow) : null;
  }

  async clearPendingAction(chatId: number, userId: number): Promise<void> {
    const { error } = await this.supabase
      .from("telegram_pending_actions")
      .delete()
      .eq("chat_id", chatId)
      .eq("user_id", userId);

    assertNoError(error, "Не получилось очистить ожидаемое действие");
  }

  async getResponseMode(chatId: number): Promise<ResponseMode> {
    const { data, error } = await this.supabase
      .from("chat_settings")
      .select("response_mode")
      .eq("chat_id", chatId)
      .maybeSingle();

    assertNoError(error, "Не получилось получить режим ответов чата");

    return (data as { response_mode?: string } | null)?.response_mode === "text" ? "text" : "image";
  }

  async setResponseMode(chatId: number, mode: ResponseMode): Promise<void> {
    const { error } = await this.supabase
      .from("chat_settings")
      .upsert(
        {
          chat_id: chatId,
          response_mode: mode,
          updated_at: new Date().toISOString()
        },
        {
          onConflict: "chat_id"
        }
      );

    assertNoError(error, "Не получилось сохранить режим ответов чата");
  }

  async rememberChat(input: { chatId: number; title: string | null; type: string }): Promise<void> {
    const { error } = await this.supabase
      .from("telegram_chats")
      .upsert(
        {
          chat_id: input.chatId,
          title: input.title,
          type: input.type,
          last_seen_at: new Date().toISOString()
        },
        {
          onConflict: "chat_id"
        }
      );

    assertNoError(error, "Не получилось сохранить чат");
  }

  async listKnownChats(): Promise<KnownChat[]> {
    const { data, error } = await this.supabase
      .from("telegram_chats")
      .select("chat_id,title,type")
      .order("last_seen_at", { ascending: false });

    assertNoError(error, "Не получилось получить список чатов");

    return ((data ?? []) as TelegramChatRow[]).map((row) => ({
      chatId: Number(row.chat_id),
      title: row.title,
      type: row.type
    }));
  }

  async listUserChatIds(userId: number): Promise<number[]> {
    const { data, error } = await this.supabase
      .from("linked_accounts")
      .select("chat_id")
      .eq("user_id", userId);

    assertNoError(error, "Не получилось получить чаты пользователя");

    const chatIds = new Set<number>();
    for (const row of (data ?? []) as Array<{ chat_id: number | string }>) {
      chatIds.add(Number(row.chat_id));
    }

    return [...chatIds];
  }

  async getDmChatSelection(userId: number): Promise<number | null> {
    const { data, error } = await this.supabase
      .from("dm_chat_selections")
      .select("chat_id")
      .eq("user_id", userId)
      .maybeSingle();

    assertNoError(error, "Не получилось получить выбранный чат");

    const row = data as { chat_id: number | string } | null;
    return row ? Number(row.chat_id) : null;
  }

  async setDmChatSelection(userId: number, chatId: number): Promise<void> {
    const { error } = await this.supabase
      .from("dm_chat_selections")
      .upsert(
        {
          user_id: userId,
          chat_id: chatId,
          selected_at: new Date().toISOString()
        },
        {
          onConflict: "user_id"
        }
      );

    assertNoError(error, "Не получилось сохранить выбранный чат");
  }
}
