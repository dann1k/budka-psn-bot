import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const sqlitePath = getArgValue("--sqlite") ?? "data/bot.sqlite";
const envFile = getArgValue("--env-file");

if (envFile) {
  loadEnvFile(envFile);
}

function getArgValue(name) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function loadEnvFile(path) {
  if (!fs.existsSync(path)) {
    throw new Error(`Env file not found: ${path}`);
  }

  const content = fs.readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] ??= value;
  }
}

function tableExists(db, tableName) {
  return Boolean(
    db
      .prepare("select name from sqlite_master where type = 'table' and name = ?")
      .get(tableName)
  );
}

function readRows(db, tableName) {
  if (!tableExists(db, tableName)) {
    return [];
  }

  return db.prepare(`select * from ${tableName}`).all();
}

function pickLinkedAccounts(db) {
  const linkedAccounts = readRows(db, "linked_accounts");
  if (linkedAccounts.length > 0) {
    return {
      source: "linked_accounts",
      rows: linkedAccounts
    };
  }

  return {
    source: "linked_profiles",
    rows: readRows(db, "linked_profiles")
  };
}

function normalizeLinkedAccount(row) {
  return {
    chat_id: Number(row.chat_id),
    user_id: Number(row.user_id),
    username: row.username ?? null,
    display_name: row.display_name,
    psn_online_id: row.psn_online_id,
    linked_at: row.linked_at
  };
}

function normalizePreference(row) {
  return {
    chat_id: Number(row.chat_id),
    user_id: Number(row.user_id),
    default_psn_online_id: row.default_psn_online_id ?? null
  };
}

async function postgrest(path, options = {}) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.BUDKA_PSN_SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !secretKey) {
    throw new Error("SUPABASE_URL and BUDKA_PSN_SUPABASE_SECRET_KEY are required for --apply");
  }

  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: secretKey,
      authorization: `Bearer ${secretKey}`,
      ...options.headers
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase REST request failed (${response.status}): ${body}`);
  }

  return response;
}

async function upsertRows(table, rows, onConflict) {
  const chunkSize = 500;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    await postgrest(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(chunk)
    });
  }
}

async function remoteCount(table) {
  const response = await postgrest(`${table}?select=*&limit=1`, {
    method: "GET",
    headers: {
      prefer: "count=exact"
    }
  });
  const range = response.headers.get("content-range");
  return range?.split("/")[1] ?? "unknown";
}

if (!fs.existsSync(sqlitePath)) {
  throw new Error(`SQLite database not found: ${sqlitePath}`);
}

const db = new DatabaseSync(sqlitePath, { readOnly: true });
const { source, rows: rawAccounts } = pickLinkedAccounts(db);
const rawPreferences = readRows(db, "user_preferences");

const linkedAccounts = rawAccounts.map(normalizeLinkedAccount);
const userPreferences = rawPreferences.map(normalizePreference);

console.log(`SQLite source: ${sqlitePath}`);
console.log(`linked_accounts source table: ${source}`);
console.log(`linked_accounts rows: ${linkedAccounts.length}`);
console.log(`user_preferences rows: ${userPreferences.length}`);

if (!apply) {
  console.log("Dry run only. Re-run with --apply to import into Supabase.");
  process.exit(0);
}

await upsertRows("linked_accounts", linkedAccounts, "chat_id,user_id,psn_online_id");
await upsertRows("user_preferences", userPreferences, "chat_id,user_id");

console.log("Import finished.");
console.log(`remote linked_accounts rows: ${await remoteCount("linked_accounts")}`);
console.log(`remote user_preferences rows: ${await remoteCount("user_preferences")}`);
