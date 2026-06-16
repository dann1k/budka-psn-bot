import { emojis } from "./emojis.ts";
import { type FeatureFlags, loadFeatureFlags } from "./features.ts";

type AppConfig = {
  botToken: string;
  telegramWebhookSecret: string;
  psnNpsso: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  psnAuthEncryptionKey: string;
  emojis: typeof emojis;
  features: FeatureFlags;
};

function readRequired(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }

  return value;
}

export function getConfig(): AppConfig {
  return {
    botToken: readRequired("BUDKA_PSN_TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecret: readRequired("BUDKA_PSN_TELEGRAM_WEBHOOK_SECRET"),
    psnNpsso: readRequired("BUDKA_PSN_NPSSO"),
    supabaseUrl: readRequired("SUPABASE_URL"),
    supabaseSecretKey: readRequired("BUDKA_PSN_SUPABASE_SECRET_KEY"),
    psnAuthEncryptionKey: readRequired("BUDKA_PSN_AUTH_ENCRYPTION_KEY"),
    emojis,
    features: loadFeatureFlags()
  };
}
