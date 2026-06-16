// Long-running entrypoint for self-hosting the bot (e.g. on a Hetzner VPS),
// outside Supabase Edge Functions. It reuses the exact same bot/PSN/DB code as
// the Edge handler (../supabase/functions/telegram-webhook/) but drives Telegram
// via long-polling instead of a webhook — so no public HTTPS, domain, reverse
// proxy or secret_token is needed. The PSN keep-alive that used to run as a
// Supabase pg_cron job runs here in-process on a daily timer.
//
// Run:  deno run -A --env-file=.env server/main.ts
import { createBot } from "../supabase/functions/telegram-webhook/bot.ts";
import { getConfig } from "../supabase/functions/telegram-webhook/config.ts";
import { PsnAuthStore } from "../supabase/functions/telegram-webhook/psn-auth-store.ts";
import { PsnService } from "../supabase/functions/telegram-webhook/psn.ts";
import { LinkRepository } from "../supabase/functions/telegram-webhook/repository.ts";

const config = getConfig();
const repository = new LinkRepository(config.supabaseUrl, config.supabaseSecretKey);
const psnAuthStore = new PsnAuthStore(config.supabaseUrl, config.supabaseSecretKey, config.psnAuthEncryptionKey);
const psnService = new PsnService(config.psnNpsso, psnAuthStore);
const bot = createBot(config, repository, psnService);

// Proactively rotate the PSN refresh token so the bot survives indefinitely even
// with zero user traffic (each rotation resets the ~60-day refresh lifetime, so a
// daily cadence leaves huge margin). Same call the old pg_cron keep-alive made.
const KEEPALIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
async function runKeepalive(): Promise<void> {
  try {
    const result = await psnService.ensureFreshAuthorization();
    console.log(`[psn-keepalive] ok status=${result.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[psn-keepalive] failed: ${message}`);
  }
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[budka] received ${signal}, stopping…`);
  await bot.stop();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => void shutdown(signal));
}

await bot.init();
// Long-polling getUpdates conflicts (HTTP 409) with any webhook Telegram still
// has registered (e.g. from a previous Supabase Edge deploy), so clear it first.
await bot.api.deleteWebhook({ drop_pending_updates: false });
console.log(`[budka] starting long-polling as @${bot.botInfo.username}`);

// Rotate once on boot (don't block startup on it), then daily.
void runKeepalive();
setInterval(() => void runKeepalive(), KEEPALIVE_INTERVAL_MS);

// Resolves only after bot.stop() (graceful shutdown above).
await bot.start({
  allowed_updates: ["message", "callback_query"] as const,
  onStart: (info) => console.log(`[budka] polling online: @${info.username}`),
});
console.log("[budka] stopped");
