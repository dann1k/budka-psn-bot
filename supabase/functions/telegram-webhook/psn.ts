import * as psnApi from "npm:psn-api@2.18.0";
import type { PersistedPsnAuthState, PsnAuthStore } from "./psn-auth-store.ts";

export type PsnPlayedGameRich = {
  name: string;
  imageUrl: string | null;
  playDuration: string;
};

export type PsnSummary = {
  onlineId: string;
  accountId: string;
  profileUrl: string;
  avatarUrl: string | null;
  hasPlus: boolean;
  presence: {
    status: "playing" | "online" | "offline";
    lastOnline: string | null;
    currentGames: string[];
  };
  recentGames: string[];
  recentGamesRich?: PsnPlayedGameRich[];
  region: {
    code: string;
    name: string;
  } | null;
  level: number;
  progress: number;
  trophies: {
    platinum: number;
    gold: number;
    silver: number;
    bronze: number;
  };
};

export class PsnPrivateProfileError extends Error {
  constructor(onlineId: string) {
    super(`PSN profile ${onlineId} is private`);
    this.name = "PsnPrivateProfileError";
  }
}

export type PsnPlatinumTitle = {
  titleName: string;
  platform: string;
  earnedAt: string;
  profileUrl: string;
  onlineId: string;
  region: {
    code: string;
    name: string;
  } | null;
};

export type PsnPlayedGame = {
  key: string;
  name: string;
  imageUrl: string | null;
  lastPlayedAt: string | null;
};

export type PsnTrophyTitleGameSource = {
  requestedOnlineId: string;
  resolvedOnlineId: string;
  accountId: string;
  titleCount: number;
  games: PsnPlayedGame[];
};

type PsnTrophyTitle = {
  trophyTitleName?: string;
  trophyTitleIconUrl?: string;
  trophyTitlePlatform?: string;
  npServiceName?: string;
  npCommunicationId?: string;
  lastUpdatedDateTime?: string;
  earnedTrophies?: {
    platinum?: number;
    gold?: number;
    silver?: number;
    bronze?: number;
  };
};

type PsnUserTitlesPage = {
  trophyTitles: PsnTrophyTitle[];
  nextOffset?: number;
};

function getPsnApiErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const error = (value as {
    error?: {
      message?: unknown;
      reason?: unknown;
      code?: unknown;
    };
  }).error;

  if (!error || typeof error !== "object") {
    return null;
  }

  const message = typeof error.message === "string" ? error.message : null;
  const reason = typeof error.reason === "string" ? error.reason : null;
  const code = error.code === undefined ? null : String(error.code);

  return [message ?? reason ?? "Unexpected PSN error", code ? `code ${code}` : null]
    .filter(Boolean)
    .join(" ");
}

function normalizeUserTitlesPage(value: unknown, onlineId: string): PsnUserTitlesPage {
  const errorMessage = getPsnApiErrorMessage(value);

  if (errorMessage) {
    throw new Error(`PSN trophy titles unavailable for ${onlineId}: ${errorMessage}`);
  }

  if (!value || typeof value !== "object") {
    throw new Error(`PSN trophy titles unavailable for ${onlineId}: empty response`);
  }

  const rawPage = value as {
    trophyTitles?: unknown;
    nextOffset?: unknown;
  };

  if (!Array.isArray(rawPage.trophyTitles)) {
    throw new Error(`PSN trophy titles unavailable for ${onlineId}: malformed response`);
  }

  return {
    trophyTitles: rawPage.trophyTitles as PsnTrophyTitle[],
    nextOffset: typeof rawPage.nextOffset === "number" ? rawPage.nextOffset : undefined
  };
}

function normalizeTrophies(
  trophies:
    | {
        platinum?: number;
        gold?: number;
        silver?: number;
        bronze?: number;
      }
    | undefined
): PsnSummary["trophies"] {
  return {
    platinum: trophies?.platinum ?? 0,
    gold: trophies?.gold ?? 0,
    silver: trophies?.silver ?? 0,
    bronze: trophies?.bronze ?? 0
  };
}

function normalizeNumber(value: number | string | undefined, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function normalizeGameName(value: string): string {
  return value.trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
}

const AVATAR_SIZE_PRIORITY: Record<string, number> = { xl: 4, l: 3, m: 2, s: 1 };

function pickLargestAvatarUrl(
  avatarUrls: ReadonlyArray<{ size?: string | null; avatarUrl?: string | null }> | undefined,
): string | null {
  if (!avatarUrls?.length) return null;

  let best: { url: string; rank: number } | null = null;

  for (const entry of avatarUrls) {
    const url = entry?.avatarUrl;
    if (!url) continue;
    const rank = AVATAR_SIZE_PRIORITY[entry?.size?.toLowerCase() ?? ""] ?? 0;
    if (!best || rank > best.rank) {
      best = { url, rank };
    }
  }

  return best?.url ?? null;
}

type AuthState = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt: number;
};

const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
// Rotate the refresh token once it is within this window of its ~60 day expiry.
const REFRESH_TOKEN_RENEW_MARGIN_MS = 7 * 24 * 60 * 60_000;
// Fallback refresh-token lifetime when PSN omits refresh_token_expires_in.
const DEFAULT_REFRESH_TOKEN_TTL_MS = 55 * 24 * 60 * 60_000;
const TOKEN_REQUEST_MAX_ATTEMPTS = 3;
const TOKEN_REQUEST_BASE_DELAY_MS = 300;

const PSN_AUTH_TOKEN_URL = "https://ca.account.sony.com/api/authz/v3/oauth/token";
const PSN_REDIRECT_URI = "com.scee.psxandroid.scecompcall://redirect";
// Public OAuth client credentials of the official PSN Android app (the same values
// the vendored psn-api uses). Safe to inline; they are not user secrets.
const PSN_CLIENT_AUTHORIZATION =
  "Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=";

/** Raised when PSN rejects the refresh token / access code as permanently invalid. */
export class PsnInvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsnInvalidGrantError";
  }
}

/** Raised for retryable PSN auth failures (network, 5xx, 429, malformed body). */
export class PsnTransientAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsnTransientAuthError";
  }
}

/** Raised when the NPSSO cookie itself is invalid or expired. */
export class PsnNpssoInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsnNpssoInvalidError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RawTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  refresh_token_expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

function isInvalidGrantReason(reason: string): boolean {
  return (
    reason === "invalid_grant" ||
    reason === "invalid_request" ||
    reason === "unauthorized_client" ||
    reason === "access_denied"
  );
}

/**
 * Performs a PSN OAuth /token request and ALWAYS validates the HTTP response.
 * The vendored psn-api exchange* helpers skip the res.ok check, so an error
 * response is silently parsed as success (undefined fields -> NaN expiry ->
 * corrupted/abandoned auth state, then an eager fall-through to the NPSSO escape
 * hatch). This wrapper turns failures into typed errors so the caller can tell a
 * permanently dead token apart from a transient blip.
 */
async function requestAuthTokens(body: URLSearchParams): Promise<AuthState> {
  let response: Response;

  try {
    response = await fetch(PSN_AUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: PSN_CLIENT_AUTHORIZATION
      },
      body: body.toString()
    });
  } catch (error) {
    throw new PsnTransientAuthError(
      `PSN token request network failure: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const rawText = await response.text();
  let parsed: RawTokenResponse = {};

  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as RawTokenResponse;
    } catch {
      parsed = {};
    }
  }

  if (!response.ok) {
    const reason = typeof parsed.error === "string" ? parsed.error : "unknown_error";
    const description =
      typeof parsed.error_description === "string" ? parsed.error_description : rawText.slice(0, 200);

    if ((response.status === 400 || response.status === 401) && isInvalidGrantReason(reason)) {
      throw new PsnInvalidGrantError(`PSN rejected token (${response.status} ${reason}): ${description}`);
    }

    throw new PsnTransientAuthError(`PSN token endpoint error (${response.status} ${reason}): ${description}`);
  }

  const accessToken = parsed.access_token;
  const refreshToken = parsed.refresh_token;
  const expiresIn = parsed.expires_in;

  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0 ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new PsnTransientAuthError(`PSN token response missing required fields: ${rawText.slice(0, 200)}`);
  }

  const now = Date.now();
  const refreshTokenExpiresIn = parsed.refresh_token_expires_in;
  const refreshTokenTtlMs =
    typeof refreshTokenExpiresIn === "number" &&
    Number.isFinite(refreshTokenExpiresIn) &&
    refreshTokenExpiresIn > 0
      ? refreshTokenExpiresIn * 1000
      : DEFAULT_REFRESH_TOKEN_TTL_MS;

  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    refreshTokenExpiresAt: now + refreshTokenTtlMs
  };
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: {
      status?: unknown;
    };
  };
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status;

  if (typeof status === "number") {
    return status;
  }

  if (typeof status === "string") {
    const parsed = Number.parseInt(status, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function isPsnAuthError(error: unknown): boolean {
  const status = getErrorStatus(error);

  if (status === 401) {
    return true;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("unauthorized") ||
      message.includes("access token") ||
      message.includes("invalid token") ||
      message.includes("expired")
    );
  }

  return false;
}

export class PsnService {
  private authState: AuthState | null = null;
  private refreshInFlight: Promise<AuthState> | null = null;

  constructor(
    private readonly npsso: string,
    private readonly authStore: PsnAuthStore
  ) {}

  async getSummaryByOnlineId(onlineId: string): Promise<PsnSummary> {
    return await this.withAuthRetry(async (accessToken) => {
      const { profile, profileUrl } = await this.getResolvedProfile(accessToken, onlineId);
      const [summary, regionInfo, presence, playedGamesRich] = await Promise.all([
        psnApi.getUserTrophyProfileSummary({ accessToken }, profile.accountId),
        psnApi.getUserRegion({ accessToken }, profile.onlineId ?? onlineId, ["ru", "en"]),
        this.getPresenceSafe(accessToken, profile.accountId),
        this.getPlayedGamesRichSafe(accessToken, profile.accountId)
      ]);
      const region = regionInfo
        ? {
            code: regionInfo.code,
            name: regionInfo.name ?? regionInfo.code
          }
        : null;
      const profileTrophySummary = profile.trophySummary;
      const hasPublicTrophyData =
        summary.trophyLevel !== undefined ||
        summary.progress !== undefined ||
        summary.earnedTrophies !== undefined ||
        profileTrophySummary !== undefined;

      if (!hasPublicTrophyData) {
        throw new PsnPrivateProfileError(onlineId);
      }

      const trophies = normalizeTrophies(summary.earnedTrophies ?? profileTrophySummary?.earnedTrophies);

      return {
        onlineId: profile.onlineId ?? onlineId,
        accountId: profile.accountId,
        profileUrl,
        avatarUrl: pickLargestAvatarUrl(profile.avatarUrls),
        hasPlus: profile.plus === 1,
        presence,
        recentGames: playedGamesRich.map((g) => g.name),
        recentGamesRich: playedGamesRich,
        region,
        level: normalizeNumber(summary.trophyLevel, normalizeNumber(profileTrophySummary?.level)),
        progress: normalizeNumber(summary.progress, normalizeNumber(profileTrophySummary?.progress)),
        trophies
      };
    });
  }

  async getPlatinumTitlesByOnlineId(onlineId: string): Promise<PsnPlatinumTitle[]> {
    return await this.withAuthRetry(async (accessToken) => {
      const { profile, profileUrl } = await this.getResolvedProfile(accessToken, onlineId);
      const regionInfo = await psnApi.getUserRegion(
        { accessToken },
        profile.onlineId ?? onlineId,
        ["ru", "en"]
      );
      const region = regionInfo
        ? {
            code: regionInfo.code,
            name: regionInfo.name ?? regionInfo.code
          }
        : null;
      const titles: PsnPlatinumTitle[] = [];
      let offset = 0;

      while (true) {
        const page = normalizeUserTitlesPage(
          await psnApi.getUserTitles(
            { accessToken },
            profile.accountId,
            { limit: 800, offset }
          ),
          profile.onlineId ?? onlineId
        );

        titles.push(
          ...page.trophyTitles
            .filter((title) => normalizeTrophies(title.earnedTrophies).platinum > 0)
            .map((title) => ({
              titleName: title.trophyTitleName ?? "Unknown title",
              platform: title.trophyTitlePlatform ?? "unknown",
              earnedAt: title.lastUpdatedDateTime ?? "",
              profileUrl,
              onlineId: profile.onlineId ?? onlineId,
              region
            }))
        );

        if (page.nextOffset === undefined) {
          break;
        }

        offset = page.nextOffset;
      }

      return titles;
    });
  }

  async getTrophyTitleGamesByOnlineId(onlineId: string): Promise<PsnTrophyTitleGameSource> {
    return await this.withAuthRetry(async (accessToken) => {
      const profile = await this.getProfile(accessToken, onlineId);
      const games = new Map<string, PsnPlayedGame>();
      let titleCount = 0;
      let offset = 0;

      while (true) {
        const page = normalizeUserTitlesPage(
          await psnApi.getUserTitles(
            { accessToken },
            profile.accountId,
            { limit: 800, offset }
          ),
          profile.onlineId ?? onlineId
        );

        titleCount += page.trophyTitles.length;

        for (const title of page.trophyTitles) {
          const name = title.trophyTitleName ?? "";
          const normalizedName = normalizeGameName(name);

          if (!normalizedName) {
            continue;
          }

          const key = title.npCommunicationId
            ? `trophy:${title.npServiceName}:${title.npCommunicationId}`
            : `name:${normalizedName}:${title.trophyTitlePlatform}`;
          const lastPlayedAt = title.lastUpdatedDateTime || null;
          const existing = games.get(key);

          if (
            !existing ||
            (Date.parse(lastPlayedAt ?? "") || 0) > (Date.parse(existing.lastPlayedAt ?? "") || 0)
          ) {
            games.set(key, {
              key,
              name,
              imageUrl: title.trophyTitleIconUrl ?? null,
              lastPlayedAt
            });
          }
        }

        if (page.nextOffset === undefined || page.nextOffset <= offset || page.trophyTitles.length === 0) {
          break;
        }

        offset = page.nextOffset;
      }

      return {
        requestedOnlineId: onlineId,
        resolvedOnlineId: profile.onlineId ?? onlineId,
        accountId: profile.accountId,
        titleCount,
        games: [...games.values()]
      };
    });
  }

  async getPlayedGamesByOnlineId(onlineId: string): Promise<PsnPlayedGame[]> {
    return (await this.getTrophyTitleGamesByOnlineId(onlineId)).games;
  }

  private async getProfile(accessToken: string, onlineId: string) {
    const profileResponse = await psnApi.getProfileFromUserName({ accessToken }, onlineId);
    return profileResponse.profile;
  }

  private async getResolvedProfile(accessToken: string, onlineId: string) {
    const profile = await this.getProfile(accessToken, onlineId);
    const shareableLink = await psnApi.getProfileShareableLink({ accessToken }, profile.accountId);

    return {
      profile,
      profileUrl: shareableLink.shareUrl
    };
  }

  private async getPresenceSafe(accessToken: string, accountId: string): Promise<PsnSummary["presence"]> {
    try {
      const response = await psnApi.getBasicPresence({ accessToken }, accountId);
      const basicPresence = response.basicPresence;
      const currentGames = (basicPresence.gameTitleInfoList ?? []).map((game) => game.titleName).filter(Boolean);
      const lastOnline =
        basicPresence.primaryPlatformInfo?.lastOnlineDate ??
        basicPresence.lastOnlineDate ??
        basicPresence.lastAvailableDate ??
        null;

      const status: PsnSummary["presence"]["status"] =
        currentGames.length > 0
          ? "playing"
          : basicPresence.primaryPlatformInfo?.onlineStatus === "online" ||
              basicPresence.onlineStatus === "online" ||
              basicPresence.availability === "availableToPlay"
            ? "online"
            : "offline";

      return {
        status,
        lastOnline,
        currentGames: currentGames.slice(0, 3)
      };
    } catch {
      return {
        status: "offline",
        lastOnline: null,
        currentGames: []
      };
    }
  }

  private async getPlayedGamesSafe(accessToken: string, accountId: string): Promise<string[]> {
    try {
      const response = await psnApi.getUserPlayedGames(
        { accessToken },
        accountId,
        { limit: 3, offset: 0, categories: "ps5_native_game,ps4_game,pspc_game,unknown" }
      );

      return response.titles
        .slice(0, 3)
        .map((title) => title.localizedName || title.name)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async getPlayedGamesRichSafe(accessToken: string, accountId: string): Promise<PsnPlayedGameRich[]> {
    try {
      const response = await psnApi.getUserPlayedGames(
        { accessToken },
        accountId,
        { limit: 3, offset: 0, categories: "ps5_native_game,ps4_game,pspc_game,unknown" }
      );

      return (response.titles || []).slice(0, 3).map((title) => ({
        name: title.localizedName || title.name,
        imageUrl: title.localizedImageUrl || title.imageUrl || title.concept?.media?.images?.[0]?.url || null,
        playDuration: title.playDuration || "PT0H"
      }));
    } catch {
      return [];
    }
  }

  private isAccessFresh(state: AuthState, now = Date.now()): boolean {
    return Number.isFinite(state.expiresAt) && state.expiresAt - TOKEN_REFRESH_MARGIN_MS > now;
  }

  private refreshTokenNeedsRotation(state: AuthState, now = Date.now()): boolean {
    // Unknown expiry (legacy rows / PSN omitted it) -> rotate to learn the window.
    if (!Number.isFinite(state.refreshTokenExpiresAt)) {
      return true;
    }

    return state.refreshTokenExpiresAt - REFRESH_TOKEN_RENEW_MARGIN_MS <= now;
  }

  private isUsable(state: AuthState, now = Date.now()): boolean {
    return this.isAccessFresh(state, now) && !this.refreshTokenNeedsRotation(state, now);
  }

  private async withAuthRetry<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    const auth = await this.getAuthorization();

    try {
      return await operation(auth.accessToken);
    } catch (error) {
      if (!isPsnAuthError(error)) {
        throw error;
      }

      this.authState = null;
      const refreshedAuth = await this.getAuthorization({ forceRefresh: true });
      return await operation(refreshedAuth.accessToken);
    }
  }

  private async getAuthorization(options: { forceRefresh?: boolean } = {}): Promise<{ accessToken: string }> {
    const now = Date.now();

    if (!options.forceRefresh && this.authState && this.isUsable(this.authState, now)) {
      return { accessToken: this.authState.accessToken };
    }

    const persistedAuthState = await this.authStore.load();

    if (!options.forceRefresh && persistedAuthState && this.isUsable(persistedAuthState, now)) {
      this.authState = persistedAuthState;
      return { accessToken: persistedAuthState.accessToken };
    }

    // We must refresh (or bootstrap). Remember whether we still hold a valid access
    // token: if so, a *transient* failure while proactively rotating the refresh
    // token must NOT fail the request — we can keep using the still-fresh token.
    const current = this.authState && Number.isFinite(this.authState.expiresAt) ? this.authState : persistedAuthState;
    const accessStillFresh = !options.forceRefresh && current != null && this.isAccessFresh(current, now);

    try {
      const authState = await this.runRefresh(persistedAuthState);
      return { accessToken: authState.accessToken };
    } catch (error) {
      if (accessStillFresh && current && error instanceof PsnTransientAuthError) {
        console.warn(
          `[psn-auth] proactive refresh-token rotation failed transiently; using still-fresh access token: ${error.message}`
        );
        this.authState = current;
        return { accessToken: current.accessToken };
      }

      throw error;
    }
  }

  // Collapse concurrent refreshes within this isolate into a single network call so
  // two simultaneous requests do not both burn (and rotate) the single-use token.
  private runRefresh(persistedAuthState: PersistedPsnAuthState | null): Promise<AuthState> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.establishAuthorization(persistedAuthState).finally(() => {
        this.refreshInFlight = null;
      });
    }

    return this.refreshInFlight;
  }

  private async establishAuthorization(persistedAuthState: PersistedPsnAuthState | null): Promise<AuthState> {
    const refreshToken = this.authState?.refreshToken ?? persistedAuthState?.refreshToken ?? null;

    if (refreshToken && refreshToken.trim().length > 0) {
      try {
        const refreshed = await this.refreshAuthorization(refreshToken);
        console.log("[psn-auth] access token refreshed via refresh token");
        return refreshed;
      } catch (error) {
        if (error instanceof PsnInvalidGrantError) {
          // The refresh token is dead. A concurrent isolate may have just rotated it
          // (PSN refresh tokens are single-use), so reload and adopt a newer one
          // before resorting to the NPSSO bootstrap.
          const reloaded = await this.authStore.load();
          if (
            reloaded?.refreshToken &&
            reloaded.refreshToken.trim().length > 0 &&
            reloaded.refreshToken !== refreshToken
          ) {
            try {
              const refreshed = await this.refreshAuthorization(reloaded.refreshToken);
              console.log("[psn-auth] adopted refresh token rotated by another instance");
              return refreshed;
            } catch (innerError) {
              if (!(innerError instanceof PsnInvalidGrantError)) {
                throw innerError;
              }
              console.error(`[psn-auth] reloaded refresh token also invalid: ${innerError.message}`);
            }
          }
          console.error(
            `[psn-auth] refresh token permanently invalid; bootstrapping from NPSSO: ${error.message}`
          );
        } else {
          // Transient failure (already retried with backoff). Never burn the NPSSO
          // escape hatch on a momentary PSN/network hiccup.
          console.error(
            `[psn-auth] transient refresh failure after retries; not falling back to NPSSO: ${(error as Error).message}`
          );
          throw error;
        }
      }
    } else {
      console.log("[psn-auth] no usable refresh token; bootstrapping from NPSSO");
    }

    const bootstrapped = await this.createAuthorizationFromNpsso();
    console.log("[psn-auth] auth state bootstrapped from NPSSO");
    return bootstrapped;
  }

  /**
   * Proactively rotates the refresh token to reset its ~60 day lifetime. Intended to
   * be triggered by a scheduled keep-alive so the bot survives indefinitely even with
   * zero user traffic. Non-destructive: a transient failure leaves the existing valid
   * token in place and never falls back to NPSSO.
   */
  async ensureFreshAuthorization(): Promise<{ status: string; refreshTokenExpiresAt: number | null }> {
    const persistedAuthState = await this.authStore.load();
    const refreshToken = this.authState?.refreshToken ?? persistedAuthState?.refreshToken ?? null;

    if (refreshToken && refreshToken.trim().length > 0) {
      try {
        const rotated = await this.refreshAuthorization(refreshToken);
        console.log(
          `[psn-keepalive] rotated refresh token; valid until ${new Date(rotated.refreshTokenExpiresAt).toISOString()}`
        );
        return { status: "rotated", refreshTokenExpiresAt: rotated.refreshTokenExpiresAt };
      } catch (error) {
        if (error instanceof PsnInvalidGrantError) {
          const reloaded = await this.authStore.load();
          if (
            reloaded?.refreshToken &&
            reloaded.refreshToken !== refreshToken &&
            this.isAccessFresh(reloaded)
          ) {
            this.authState = reloaded;
            console.log("[psn-keepalive] token already rotated by another instance; nothing to do");
            return { status: "already-fresh", refreshTokenExpiresAt: reloaded.refreshTokenExpiresAt };
          }

          console.error(`[psn-keepalive] refresh token dead; bootstrapping from NPSSO: ${error.message}`);
          const bootstrapped = await this.createAuthorizationFromNpsso();
          return { status: "bootstrapped", refreshTokenExpiresAt: bootstrapped.refreshTokenExpiresAt };
        }

        console.error(`[psn-keepalive] transient failure; keeping existing token: ${(error as Error).message}`);
        return {
          status: "transient-skip",
          refreshTokenExpiresAt: persistedAuthState?.refreshTokenExpiresAt ?? null
        };
      }
    }

    console.log("[psn-keepalive] no refresh token; bootstrapping from NPSSO");
    const bootstrapped = await this.createAuthorizationFromNpsso();
    return { status: "bootstrapped", refreshTokenExpiresAt: bootstrapped.refreshTokenExpiresAt };
  }

  private async refreshAuthorization(refreshToken: string): Promise<AuthState> {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      token_format: "jwt",
      scope: "psn:mobile.v2.core psn:clientapp"
    });

    const authState = await this.requestAuthTokensWithRetry(body);
    await this.saveAuthState(authState);
    return authState;
  }

  private async createAuthorizationFromNpsso(): Promise<AuthState> {
    let accessCode: string;

    try {
      accessCode = await psnApi.exchangeNpssoForAccessCode(this.npsso);
    } catch (error) {
      throw new PsnNpssoInvalidError(
        (error instanceof Error ? error.message : String(error)).trim() || "NPSSO is invalid or expired"
      );
    }

    const body = new URLSearchParams({
      code: accessCode,
      redirect_uri: PSN_REDIRECT_URI,
      grant_type: "authorization_code",
      token_format: "jwt"
    });

    const authState = await this.requestAuthTokensWithRetry(body);
    await this.saveAuthState(authState);
    return authState;
  }

  private async requestAuthTokensWithRetry(body: URLSearchParams): Promise<AuthState> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= TOKEN_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await requestAuthTokens(body);
      } catch (error) {
        lastError = error;

        // Permanent failures must not be retried: a dead token / invalid NPSSO will
        // never recover by trying again.
        if (error instanceof PsnInvalidGrantError || error instanceof PsnNpssoInvalidError) {
          throw error;
        }

        if (attempt < TOKEN_REQUEST_MAX_ATTEMPTS) {
          const delayMs = TOKEN_REQUEST_BASE_DELAY_MS * 2 ** (attempt - 1);
          console.warn(
            `[psn-auth] transient token request failure (attempt ${attempt}/${TOKEN_REQUEST_MAX_ATTEMPTS}): ${(error as Error).message}; retrying in ${delayMs}ms`
          );
          await sleep(delayMs);
        }
      }
    }

    throw lastError;
  }

  private async saveAuthState(authState: AuthState): Promise<void> {
    await this.authStore.save(authState);
    this.authState = authState;
  }
}
