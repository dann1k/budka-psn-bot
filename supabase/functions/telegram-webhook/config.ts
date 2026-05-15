import { emojis } from "./emojis.ts";

type AppConfig = {
  botToken: string;
  telegramWebhookSecret: string;
  psnNpsso: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  emojis: typeof emojis;
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
    supabaseServiceRoleKey: readRequired("BUDKA_PSN_SUPABASE_SERVICE_ROLE_KEY"),
    emojis
  };
}
