import * as psnApi from "npm:psn-api@2.18.0";

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

type AuthState = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export class PsnService {
  private authState: AuthState | null = null;

  constructor(private readonly npsso: string) {}

  async getSummaryByOnlineId(onlineId: string): Promise<PsnSummary> {
    const auth = await this.getAuthorization();
    const { profile, profileUrl } = await this.getResolvedProfile(auth.accessToken, onlineId);
    const [summary, regionInfo, presence, playedGames] = await Promise.all([
      psnApi.getUserTrophyProfileSummary({ accessToken: auth.accessToken }, profile.accountId),
      psnApi.getUserRegion({ accessToken: auth.accessToken }, profile.onlineId ?? onlineId, ["ru", "en"]),
      this.getPresenceSafe(auth.accessToken, profile.accountId),
      this.getPlayedGamesSafe(auth.accessToken, profile.accountId)
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
  }

  async getPlatinumTitlesByOnlineId(onlineId: string): Promise<PsnPlatinumTitle[]> {
    const auth = await this.getAuthorization();
    const { profile, profileUrl } = await this.getResolvedProfile(auth.accessToken, onlineId);
    const regionInfo = await psnApi.getUserRegion(
      { accessToken: auth.accessToken },
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
        { accessToken: auth.accessToken },
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
  }

  private async getResolvedProfile(accessToken: string, onlineId: string) {
    const profileResponse = await psnApi.getProfileFromUserName({ accessToken }, onlineId);
    const profile = profileResponse.profile;
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

  private async getAuthorization(): Promise<{ accessToken: string }> {
    const now = Date.now();

    if (this.authState && this.authState.expiresAt - 60_000 > now) {
      return { accessToken: this.authState.accessToken };
    }

    if (this.authState?.refreshToken) {
      try {
        const refreshed = await psnApi.exchangeRefreshTokenForAuthTokens(
          this.authState.refreshToken
        );
        this.authState = {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: now + refreshed.expiresIn * 1000
        };

        return { accessToken: this.authState.accessToken };
      } catch {
        this.authState = null;
      }
    }

    const accessCode = await psnApi.exchangeNpssoForAccessCode(this.npsso);
    const tokens = await psnApi.exchangeAccessCodeForAuthTokens(accessCode);

    this.authState = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: now + tokens.expiresIn * 1000
    };

    return { accessToken: tokens.accessToken };
  }
}
