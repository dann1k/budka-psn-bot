// Сравнивает два пути получения «недавних игр» одним и тем же свежим токеном:
//   1) GraphQL getRecentlyPlayedGames  -> web.np.playstation.com (страница
//      library.playstation.com/recently-played). Только СВОЙ аккаунт (из NPSSO).
//   2) REST getUserPlayedGames("me")   -> m.np.playstation.com/api/gamelist/v2
//      (текущий путь бота, сейчас отдаёт 0).
//
// Запуск на VPS:
//   ssh root@62.238.13.6 '/usr/local/bin/deno run -A --env-file=/opt/budka-psn-bot/.env -' < scripts/psn-recent-graphql-probe.ts
//
// Чтение: GraphQL > 0, а REST == 0  -> Sony деградировала REST gamelist v2,
// фикс = перевести бота на GraphQL. Оба 0 -> это PSN-инцидент play-activity,
// тогда ждём восстановления (см. также library.playstation.com/recently-played).

import * as psnApi from "npm:psn-api@2.18.0";

const npsso = Deno.env.get("BUDKA_PSN_NPSSO");
if (!npsso) {
  console.error("BUDKA_PSN_NPSSO не задан");
  Deno.exit(1);
}

const code = await psnApi.exchangeNpssoForAccessCode(npsso);
const auth = await psnApi.exchangeAccessCodeForAuthTokens(code);
console.log(`minted scope="${auth.scope}"`);

// 1) GraphQL (web.np) — то, чем рендерит library.playstation.com/recently-played.
try {
  const gql = await psnApi.getRecentlyPlayedGames(
    { accessToken: auth.accessToken },
    { limit: 10, categories: ["ps4_game", "ps5_native_game"] },
  );
  const games = gql?.data?.gameLibraryTitlesRetrieve?.games ?? [];
  console.log(`GraphQL getRecentlyPlayedGames: ${games.length} games`);
  for (const g of games) console.log(`  - ${g.name} [${g.platform}] last=${g.lastPlayedDateTime}`);
} catch (err) {
  console.error("GraphQL getRecentlyPlayedGames threw:", err instanceof Error ? err.message : err);
}

// 2) REST (m.np) gamelist v2 — текущий путь бота.
try {
  const rest = await psnApi.getUserPlayedGames(
    { accessToken: auth.accessToken },
    "me",
    { limit: 10, offset: 0, categories: "ps5_native_game,ps4_game,pspc_game,unknown" },
  );
  console.log(`REST getUserPlayedGames(me): ${(rest.titles ?? []).length} titles`);
} catch (err) {
  console.error("REST getUserPlayedGames threw:", err instanceof Error ? err.message : err);
}
