// PSN gamelist v2 — IP-gating probe.
//
// Мятит свежий токен из BUDKA_PSN_NPSSO (грант authorization_code — самый
// широкий возможный scope) и спрашивает у gamelist v2 СОБСТВЕННЫЕ сыгранные
// игры аккаунта ("me"). "me" всегда видно самому себе, поэтому приватность,
// дружба и тип токена тут исключены — переменная ровно одна: исходящий IP.
//
// Запусти ОДИН И ТОТ ЖЕ скрипт с двух адресов с одним и тем же NPSSO:
//   VPS:    ssh root@62.238.13.6 'deno run -A --env-file=/opt/budka-psn-bot/.env -' < scripts/psn-gamelist-probe.ts
//   ноут:   BUDKA_PSN_NPSSO="$(ssh root@62.238.13.6 'sed -n "s/^BUDKA_PSN_NPSSO=//p" /opt/budka-psn-bot/.env')" \
//             deno run -A scripts/psn-gamelist-probe.ts
//
// Опционально первым аргументом можно передать числовой accountId вместо "me".
//
// Чтение: если на ноуте titles > 0, а на VPS titles == 0 при одинаковом токене —
// это IP-гейтинг gamelist v2 для адреса Hetzner. Если пусто в обоих местах —
// причина не в IP, копаем дальше (тип токена/эндпоинт).

import * as psnApi from "npm:psn-api@2.18.0";

const npsso = Deno.env.get("BUDKA_PSN_NPSSO");
if (!npsso) {
  console.error("BUDKA_PSN_NPSSO не задан (используй --env-file=.../.env или export).");
  Deno.exit(1);
}

const accountId = Deno.args[0] ?? "me";
const CATEGORIES = "ps5_native_game,ps4_game,pspc_game,unknown";

// Самоидентификация запуска: какой egress-IP видит интернет.
try {
  const egress = (await (await fetch("https://api.ipify.org")).text()).trim();
  console.log(`egress IP: ${egress}`);
} catch {
  console.log("egress IP: (не удалось определить)");
}

// authorization_code — свежий токен с тем же scope, что зашивает psn-api.
const code = await psnApi.exchangeNpssoForAccessCode(npsso);
const auth = await psnApi.exchangeAccessCodeForAuthTokens(code);
console.log(`minted: scope="${auth.scope}" expiresIn=${auth.expiresIn}s tokenType=${auth.tokenType}`);
console.log(`query accountId: ${accountId}`);

// 1) Тот же путь, что у бота в проде.
try {
  const res = await psnApi.getUserPlayedGames(
    { accessToken: auth.accessToken },
    accountId,
    { limit: 5, offset: 0, categories: CATEGORIES },
  );
  const titles = res.titles ?? [];
  console.log(`psn-api getUserPlayedGames: ${titles.length} titles`, titles.map((t) => t.name));
} catch (err) {
  console.error("psn-api getUserPlayedGames threw:", err instanceof Error ? err.message : err);
}

// 2) Сырой запрос — показывает HTTP-статус, троттл/регион-заголовки и начало тела
//    (psn-api это всё прячет, а именно тут видно 200-пусто vs 403/429).
const url =
  `https://m.np.playstation.com/api/gamelist/v2/users/${accountId}/titles` +
  `?limit=5&offset=0&categories=${CATEGORIES}`;
const r = await fetch(url, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
const body = await r.text();
console.log(`raw HTTP ${r.status} ${r.statusText}`);
for (
  const h of [
    "x-psn-request-id",
    "x-rate-limit-limit",
    "x-rate-limit-remaining",
    "x-rate-limit-reset",
    "retry-after",
    "cf-ray",
    "server",
    "content-length",
  ]
) {
  const v = r.headers.get(h);
  if (v) console.log(`  ${h}: ${v}`);
}
console.log("raw body head:", body.slice(0, 600));
