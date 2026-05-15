import fs from "node:fs";

const args = new Set(process.argv.slice(2));
const envFile = getArgValue("--env-file");
const shouldPrintToken = args.has("--print-token");

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

const npsso = process.env.BUDKA_PSN_NPSSO;

if (!npsso) {
  console.error("BUDKA_PSN_NPSSO is required.");
  console.error("Pass it via env or --env-file=path/to/.env.local.");
  process.exit(1);
}

const authBaseUrl = "https://ca.account.sony.com/api/authz/v3/oauth";
const authClientBasic =
  "Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=";
const redirectUri = "com.scee.psxandroid.scecompcall://redirect";

async function exchangeNpssoForAccessCode(npssoToken) {
  const queryString = new URLSearchParams({
    access_type: "offline",
    client_id: "09515159-7237-4370-9b40-3806e67c0891",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "psn:mobile.v2.core psn:clientapp"
  }).toString();
  const response = await fetch(`${authBaseUrl}/authorize?${queryString}`, {
    headers: {
      cookie: `npsso=${npssoToken}`
    },
    redirect: "manual"
  });
  const location = response.headers.get("location");

  if (!location || !location.includes("?code=")) {
    throw new Error(
      "Could not retrieve PSN access code. Check BUDKA_PSN_NPSSO or get a fresh NPSSO from https://ca.account.sony.com/api/v1/ssocookie."
    );
  }

  const redirectParams = new URLSearchParams(location.split("redirect/")[1]);
  const code = redirectParams.get("code");

  if (!code) {
    throw new Error("PSN access code was missing from redirect location.");
  }

  return code;
}

async function exchangeAccessCodeForAuthTokens(accessCode) {
  const response = await fetch(`${authBaseUrl}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: authClientBasic
    },
    body: new URLSearchParams({
      code: accessCode,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      token_format: "jwt"
    }).toString()
  });

  if (!response.ok) {
    throw new Error(`PSN token exchange failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const raw = await response.json();

  return {
    accessToken: raw.access_token,
    expiresIn: raw.expires_in,
    refreshToken: raw.refresh_token,
    refreshTokenExpiresIn: raw.refresh_token_expires_in
  };
}

const accessCode = await exchangeNpssoForAccessCode(npsso);
const tokens = await exchangeAccessCodeForAuthTokens(accessCode);

console.log(`expiresIn: ${tokens.expiresIn}s`);
console.log(`expiresAt: ${new Date(Date.now() + tokens.expiresIn * 1000).toISOString()}`);

if (!shouldPrintToken) {
  console.log("Access token received. Re-run with --print-token to print it for manual curl debugging.");
  process.exit(0);
}

console.log(tokens.accessToken);
