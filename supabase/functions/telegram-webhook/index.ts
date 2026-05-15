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
  timeoutMilliseconds: 55_000
});

Deno.serve((request) => {
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
