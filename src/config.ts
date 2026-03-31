import "dotenv/config";
import fs from "node:fs";

export type EmojiToken = {
  value: string;
  id?: string;
};

type AppConfig = {
  botToken: string;
  psnNpsso: string;
  databasePath: string;
  emojis: EmojiConfig;
};

export type EmojiConfig = {
  trophies: {
    platinum: EmojiToken;
    gold: EmojiToken;
    silver: EmojiToken;
    bronze: EmojiToken;
  };
  icons: {
    profile: EmojiToken;
    plus: EmojiToken;
    statusOnline: EmojiToken;
    statusOffline: EmojiToken;
    statusPlaying: EmojiToken;
  };
};

const defaultEmojiConfig: EmojiConfig = {
  trophies: {
    platinum: { value: "💎" },
    gold: { value: "🥇" },
    silver: { value: "🥈" },
    bronze: { value: "🥉" }
  },
  icons: {
    profile: { value: "PSN" },
    plus: { value: "➕" },
    statusOnline: { value: "🟢" },
    statusOffline: { value: "⚪" },
    statusPlaying: { value: "🎮" }
  }
};

function readRequired(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }

  return value;
}

export function getConfig(): AppConfig {
  return {
    botToken: readRequired("BOT_TOKEN"),
    psnNpsso: readRequired("PSN_NPSSO"),
    databasePath: process.env.DATABASE_PATH ?? "./data/bot.sqlite",
    emojis: readEmojiConfig()
  };
}

function readEmojiConfig(): EmojiConfig {
  const configPath = "./config/emojis.json";

  if (!fs.existsSync(configPath)) {
    return defaultEmojiConfig;
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<EmojiConfig>;

  return {
    trophies: {
      platinum: normalizeEmojiToken(parsed.trophies?.platinum, defaultEmojiConfig.trophies.platinum),
      gold: normalizeEmojiToken(parsed.trophies?.gold, defaultEmojiConfig.trophies.gold),
      silver: normalizeEmojiToken(parsed.trophies?.silver, defaultEmojiConfig.trophies.silver),
      bronze: normalizeEmojiToken(parsed.trophies?.bronze, defaultEmojiConfig.trophies.bronze)
    },
    icons: {
      profile: normalizeEmojiToken(parsed.icons?.profile, defaultEmojiConfig.icons.profile),
      plus: normalizeEmojiToken(parsed.icons?.plus, defaultEmojiConfig.icons.plus),
      statusOnline: normalizeEmojiToken(parsed.icons?.statusOnline, defaultEmojiConfig.icons.statusOnline),
      statusOffline: normalizeEmojiToken(parsed.icons?.statusOffline, defaultEmojiConfig.icons.statusOffline),
      statusPlaying: normalizeEmojiToken(parsed.icons?.statusPlaying, defaultEmojiConfig.icons.statusPlaying)
    }
  };
}

function normalizeEmojiToken(
  token: EmojiToken | string | undefined,
  fallback: EmojiToken
): EmojiToken {
  if (!token) {
    return fallback;
  }

  if (typeof token === "string") {
    return { value: token };
  }

  return {
    value: token.value || fallback.value,
    id: token.id
  };
}
