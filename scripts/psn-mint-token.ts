// Печатает ТОЛЬКО свежий PSN access-token (bearer), сминченный из BUDKA_PSN_NPSSO.
// Диагностика идёт в stderr, сам токен — в stdout, чтобы его можно было поймать в
// переменную:  TOKEN="$(... deno run -A --env-file=.env - < scripts/psn-mint-token.ts)"
import * as psnApi from "npm:psn-api@2.18.0";

const npsso = Deno.env.get("BUDKA_PSN_NPSSO");
if (!npsso) {
  console.error("BUDKA_PSN_NPSSO не задан");
  Deno.exit(1);
}

const code = await psnApi.exchangeNpssoForAccessCode(npsso);
const auth = await psnApi.exchangeAccessCodeForAuthTokens(code);
console.error(`minted scope="${auth.scope}" expiresIn=${auth.expiresIn}s`);
console.log(auth.accessToken);
