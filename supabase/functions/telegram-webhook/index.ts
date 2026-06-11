import { webhookCallback } from "npm:grammy@1.41.1/web";
import { createBot } from "./bot.ts";
import { getConfig } from "./config.ts";
import { PsnAuthStore } from "./psn-auth-store.ts";
import { PsnService } from "./psn.ts";
import { LinkRepository } from "./repository.ts";

const config = getConfig();
const repository = new LinkRepository(config.supabaseUrl, config.supabaseSecretKey);
const psnAuthStore = new PsnAuthStore(config.supabaseUrl, config.supabaseSecretKey, config.psnAuthEncryptionKey);
const psnService = new PsnService(config.psnNpsso, psnAuthStore);
const bot = createBot(config, repository, psnService);
const handleTelegramWebhook = webhookCallback(bot, "std/http", {
  secretToken: config.telegramWebhookSecret,
  // Keep below PSN per-operation timeouts so a stuck handler frees the Telegram
  // webhook connection quickly instead of jamming the update queue for everyone.
  timeoutMilliseconds: 30_000
});

// Header carrying the keep-alive secret. A scheduled job (Supabase pg_cron + pg_net)
// hits this endpoint to proactively rotate the PSN refresh token so the bot survives
// indefinitely even with no user traffic. Reuses the webhook secret to avoid wiring a
// new secret through the deploy pipeline.
const KEEPALIVE_HEADER = "x-budka-keepalive";

Deno.serve(async (request) => {
  const keepaliveSecret = request.headers.get(KEEPALIVE_HEADER);

  if (keepaliveSecret !== null) {
    if (keepaliveSecret !== config.telegramWebhookSecret) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const result = await psnService.ensureFreshAuthorization();
      return Response.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[psn-keepalive] request failed: ${message}`);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  }

  if (request.method === "GET") {
    return Response.json({
      ok: true,
      service: "budka-psn-bot",
      runtime: "supabase-edge-functions"
    });
  }

  if (request.method === "POST") {
    return handleTelegramWebhook(request);
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      allow: "GET, POST"
    }
  });
});
