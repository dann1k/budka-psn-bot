import * as psnApi from "npm:psn-api@2.18.0";
import type { PersistedPsnAuthState, PsnAuthStore } from "./psn-auth-store.ts";

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
  lastPlayedAt: string | null;
};

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

type AuthState = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

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

  constructor(
    private readonly npsso: string,
    private readonly authStore: PsnAuthStore
  ) {}

  async getSummaryByOnlineId(onlineId: string): Promise<PsnSummary> {
    return await this.withAuthRetry(async (accessToken) => {
      const { profile, profileUrl } = await this.getResolvedProfile(accessToken, onlineId);
      const [summary, regionInfo, presence, playedGames] = await Promise.all([
        psnApi.getUserTrophyProfileSummary({ accessToken }, profile.accountId),
        psnApi.getUserRegion({ accessToken }, profile.onlineId ?? onlineId, ["ru", "en"]),
        this.getPresenceSafe(accessToken, profile.accountId),
        this.getPlayedGamesSafe(accessToken, profile.accountId)
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
        avatarUrl: profile.avatarUrls?.[0]?.avatarUrl ?? null,
        hasPlus: profile.plus === 1,
        presence,
        recentGames: playedGames,
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
        const page = await psnApi.getUserTitles(
          { accessToken },
          profile.accountId,
          { limit: 800, offset }
        );

        titles.push(
          ...page.trophyTitles
            .filter((title) => normalizeTrophies(title.earnedTrophies).platinum > 0)
            .map((title) => ({
              titleName: title.trophyTitleName,
              platform: title.trophyTitlePlatform,
              earnedAt: title.lastUpdatedDateTime,
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

  async getPlayedGamesByOnlineId(onlineId: string): Promise<PsnPlayedGame[]> {
    return await this.withAuthRetry(async (accessToken) => {
      const profile = await this.getProfile(accessToken, onlineId);
      const games = new Map<string, PsnPlayedGame>();
      let offset = 0;

      while (true) {
        const page = await psnApi.getUserTitles(
          { accessToken },
          profile.accountId,
          { limit: 800, offset }
        );

        for (const title of page.trophyTitles) {
          const name = title.trophyTitleName;
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
              lastPlayedAt
            });
          }
        }

        if (page.nextOffset === undefined || page.nextOffset <= offset || page.trophyTitles.length === 0) {
          break;
        }

        offset = page.nextOffset;
      }

      return [...games.values()];
    });
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

  private isFresh(state: AuthState, now = Date.now()): boolean {
    return state.expiresAt - TOKEN_REFRESH_MARGIN_MS > now;
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

    if (!options.forceRefresh && this.authState && this.isFresh(this.authState, now)) {
      return { accessToken: this.authState.accessToken };
    }

    const persistedAuthState = await this.authStore.load();

    if (!options.forceRefresh && persistedAuthState && this.isFresh(persistedAuthState, now)) {
      this.authState = persistedAuthState;
      return { accessToken: persistedAuthState.accessToken };
    }

    const refreshToken = this.authState?.refreshToken ?? persistedAuthState?.refreshToken;

    if (refreshToken) {
      try {
        const refreshed = await this.refreshAuthorization(refreshToken);
        return { accessToken: refreshed.accessToken };
      } catch {
        this.authState = null;
        const updatedPersistedAuthState = await this.authStore.load();

        if (updatedPersistedAuthState && this.isFresh(updatedPersistedAuthState)) {
          this.authState = updatedPersistedAuthState;
          return { accessToken: updatedPersistedAuthState.accessToken };
        }
      }
    }

    const tokens = await this.createAuthorizationFromNpsso();
    return { accessToken: tokens.accessToken };
  }

  private async refreshAuthorization(refreshToken: string): Promise<AuthState> {
    const refreshed = await psnApi.exchangeRefreshTokenForAuthTokens(refreshToken);
    const authState = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: Date.now() + refreshed.expiresIn * 1000
    };

    await this.saveAuthState(authState);
    return authState;
  }

  private async createAuthorizationFromNpsso(): Promise<AuthState> {
    const accessCode = await psnApi.exchangeNpssoForAccessCode(this.npsso);
    const tokens = await psnApi.exchangeAccessCodeForAuthTokens(accessCode);
    const authState = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000
    };

    await this.saveAuthState(authState);
    return authState;
  }

  private async saveAuthState(authState: PersistedPsnAuthState): Promise<void> {
    await this.authStore.save(authState);
    this.authState = authState;
  }
}
