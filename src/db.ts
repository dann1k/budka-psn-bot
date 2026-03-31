import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type LinkedAccount = {
  chatId: number;
  userId: number;
  username: string | null;
  displayName: string;
  psnOnlineId: string;
  linkedAt: string;
};

export type LinkedUser = {
  chatId: number;
  userId: number;
  username: string | null;
  displayName: string;
  defaultPsnOnlineId: string | null;
};

export class LinkRepository {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linked_accounts (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT,
        display_name TEXT NOT NULL,
        psn_online_id TEXT NOT NULL,
        linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_id, user_id, psn_online_id)
      );
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS linked_accounts_unique_psn
      ON linked_accounts (chat_id, lower(psn_online_id));
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        default_psn_online_id TEXT,
        PRIMARY KEY (chat_id, user_id)
      );
    `);

    const legacyTableExists = this.db
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'linked_profiles';
      `)
      .get() as { name: string } | undefined;

    if (!legacyTableExists) {
      return;
    }

    const hasMigratedRows = this.db
      .prepare(`SELECT COUNT(*) as count FROM linked_accounts;`)
      .get() as { count: number };

    if (hasMigratedRows.count > 0) {
      return;
    }

    this.db.exec(`
      INSERT OR IGNORE INTO linked_accounts (
        chat_id,
        user_id,
        username,
        display_name,
        psn_online_id,
        linked_at
      )
      SELECT
        chat_id,
        user_id,
        username,
        display_name,
        psn_online_id,
        linked_at
      FROM linked_profiles;
    `);
  }

  addLink(input: {
    chatId: number;
    userId: number;
    username: string | null;
    displayName: string;
    psnOnlineId: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO linked_accounts (
          chat_id,
          user_id,
          username,
          display_name,
          psn_online_id
        ) VALUES (
          @chatId,
          @userId,
          @username,
          @displayName,
          @psnOnlineId
        )
        ON CONFLICT(chat_id, user_id, psn_online_id) DO UPDATE SET
          username = excluded.username,
          display_name = excluded.display_name,
          linked_at = CURRENT_TIMESTAMP;
      `)
      .run(input);
  }

  syncUserMetadata(input: {
    chatId: number;
    userId: number;
    username: string | null;
    displayName: string;
  }): void {
    this.db
      .prepare(`
        UPDATE linked_accounts
        SET username = @username,
            display_name = @displayName
        WHERE chat_id = @chatId AND user_id = @userId;
      `)
      .run(input);
  }

  listAccountsByUser(chatId: number, userId: number): LinkedAccount[] {
    return this.db
      .prepare(`
        SELECT
          chat_id as chatId,
          user_id as userId,
          username,
          display_name as displayName,
          psn_online_id as psnOnlineId,
          linked_at as linkedAt
        FROM linked_accounts
        WHERE chat_id = ? AND user_id = ?
        ORDER BY linked_at ASC;
      `)
      .all(chatId, userId) as LinkedAccount[];
  }

  getAccountOwner(chatId: number, psnOnlineId: string): LinkedAccount | null {
    const row = this.db
      .prepare(`
        SELECT
          chat_id as chatId,
          user_id as userId,
          username,
          display_name as displayName,
          psn_online_id as psnOnlineId,
          linked_at as linkedAt
        FROM linked_accounts
        WHERE chat_id = ? AND lower(psn_online_id) = lower(?);
      `)
      .get(chatId, psnOnlineId) as LinkedAccount | undefined;

    return row ?? null;
  }

  listUsers(chatId: number): LinkedUser[] {
    return this.db
      .prepare(`
        SELECT
          chat_id as chatId,
          user_id as userId,
          username,
          display_name as displayName,
          (
            SELECT default_psn_online_id
            FROM user_preferences up
            WHERE up.chat_id = linked_accounts.chat_id
              AND up.user_id = linked_accounts.user_id
          ) as defaultPsnOnlineId
        FROM linked_accounts
        WHERE chat_id = ?
        GROUP BY chat_id, user_id
        ORDER BY MIN(linked_at) ASC;
      `)
      .all(chatId) as LinkedUser[];
  }

  findUserByUsername(chatId: number, username: string): LinkedUser | null {
    const normalized = username.replace(/^@/, "").trim().toLowerCase();
    const row = this.db
      .prepare(`
        SELECT
          chat_id as chatId,
          user_id as userId,
          username,
          display_name as displayName,
          (
            SELECT default_psn_online_id
            FROM user_preferences up
            WHERE up.chat_id = linked_accounts.chat_id
              AND up.user_id = linked_accounts.user_id
          ) as defaultPsnOnlineId
        FROM linked_accounts
        WHERE chat_id = ? AND lower(username) = ?
        GROUP BY chat_id, user_id
        LIMIT 1;
      `)
      .get(chatId, normalized) as LinkedUser | undefined;

    return row ?? null;
  }

  deleteLinks(chatId: number, userId: number, psnOnlineId?: string): number {
    if (psnOnlineId) {
      const result = this.db
        .prepare(`
          DELETE FROM linked_accounts
          WHERE chat_id = ? AND user_id = ? AND lower(psn_online_id) = lower(?);
        `)
        .run(chatId, userId, psnOnlineId);

      this.db
        .prepare(`
          UPDATE user_preferences
          SET default_psn_online_id = NULL
          WHERE chat_id = ? AND user_id = ? AND lower(default_psn_online_id) = lower(?);
        `)
        .run(chatId, userId, psnOnlineId);

      return Number(result.changes);
    }

    const result = this.db
      .prepare(`
        DELETE FROM linked_accounts
        WHERE chat_id = ? AND user_id = ?;
      `)
      .run(chatId, userId);

    this.db
      .prepare(`
        DELETE FROM user_preferences
        WHERE chat_id = ? AND user_id = ?;
      `)
      .run(chatId, userId);

    return Number(result.changes);
  }

  setDefaultAccount(chatId: number, userId: number, psnOnlineId: string): void {
    this.db
      .prepare(`
        INSERT INTO user_preferences (
          chat_id,
          user_id,
          default_psn_online_id
        ) VALUES (?, ?, ?)
        ON CONFLICT(chat_id, user_id) DO UPDATE SET
          default_psn_online_id = excluded.default_psn_online_id;
      `)
      .run(chatId, userId, psnOnlineId);
  }
}
