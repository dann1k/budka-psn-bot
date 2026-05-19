// @ts-nocheck
/** @jsx h */
/** @jsxFrag Fragment */
import satori from "npm:satori@0.13.0";
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import type { PsnSummary, PsnPlayedGameRich } from "./psn.ts";
import type { AggregatedPlayer } from "./bot.ts";
import {
  getInterBoldBuffer,
  getInterRegularBuffer,
  getResvgWasmBuffer,
  getTrophyImageDataUrl,
  preloadTrophyImages,
} from "./renderer-assets.ts";

// --- JSX Hyperscript Helper for Satori ---
export function h(type: any, props: any, ...children: any[]) {
  return {
    type,
    props: {
      ...props,
      children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
    },
  };
}

export const Fragment = (props: any) => props.children;

// Logical layout width used by Satori for all cards. Resvg rasterizes the
// SVG at CARD_LOGICAL_WIDTH * RENDER_SCALE px wide. The scale is chosen so
// the resulting PNG stays at or under Telegram's 1280px sendPhoto limit,
// avoiding server-side recompression while keeping text crisp.
const CARD_LOGICAL_WIDTH = 800;
const RENDER_SCALE = 1.6;
const RENDER_OUTPUT_WIDTH = Math.round(CARD_LOGICAL_WIDTH * RENDER_SCALE);

// Rough estimate of how many wrapped lines a row of player pills will take,
// given Satori-rendered Inter Bold 11px pills with 8px horizontal padding
// and 6px gap between pills. Slightly overestimates per-char width so the
// computed row height never clips the pills.
const PILL_AVG_CHAR_WIDTH = 7;
const PILL_HORIZONTAL_PADDING = 16;
const PILL_GAP = 6;

function estimatePillLines(players: readonly string[], maxWidth: number): number {
  if (players.length === 0) return 1;

  let lines = 1;
  let usedWidth = 0;

  for (const player of players) {
    const pillWidth = Math.ceil(player.length * PILL_AVG_CHAR_WIDTH) + PILL_HORIZONTAL_PADDING;

    if (usedWidth === 0) {
      usedWidth = pillWidth;
      continue;
    }

    if (usedWidth + PILL_GAP + pillWidth > maxWidth) {
      lines += 1;
      usedWidth = pillWidth;
    } else {
      usedWidth += PILL_GAP + pillWidth;
    }
  }

  return lines;
}

// --- Cache for WASM and Fonts ---
let isWasmInit = false;
let fontRegularBuffer: ArrayBuffer | null = null;
let fontBoldBuffer: ArrayBuffer | null = null;

function assertOpenTypeAsset(name: string, buffer: ArrayBuffer) {
  const signature = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 4)));
  const validSignatures = new Set(["\x00\x01\x00\x00", "OTTO", "ttcf", "wOFF"]);

  if (!validSignatures.has(signature)) {
    throw new Error(`Invalid font asset ${name}: unsupported OpenType signature ${JSON.stringify(signature)}`);
  }
}

async function initRenderer() {
  if (!isWasmInit) {
    const wasmBuffer = await getResvgWasmBuffer();
    await initWasm(wasmBuffer);
    isWasmInit = true;
  }

  if (!fontRegularBuffer) {
    fontRegularBuffer = await getInterRegularBuffer();
    assertOpenTypeAsset("Inter-Regular.ttf", fontRegularBuffer);
  }

  if (!fontBoldBuffer) {
    fontBoldBuffer = await getInterBoldBuffer();
    assertOpenTypeAsset("Inter-Bold.ttf", fontBoldBuffer);
  }

  await preloadTrophyImages();
}

// --- Image Fetching Helper (converts to Base64) ---
async function fetchImageBase64(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "image/png";
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

// --- Vector and Image Helpers for UI ---
const TrophyIcon = ({ type, size = 20 }: { type: "platinum" | "gold" | "silver" | "bronze"; size?: number }) => {
  return (
    <img
      src={getTrophyImageDataUrl(type)}
      style={{
        display: "flex",
        width: `${size}px`,
        height: `${size}px`,
        objectFit: "contain",
      }}
    />
  );
};

const PlusIcon = ({ size = 22 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="#facc15"
    style={{ display: "flex" }}
  >
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-6H5v-2h6V5h2v6h6v2h-6v6z" />
  </svg>
);

const CrownIcon = ({ size = 28 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="#facc15"
    stroke="#eab308"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: "flex" }}
  >
    <path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z" />
    <path d="M3 20h18" strokeWidth="2" />
  </svg>
);

const AvatarPlaceholder = ({ label, fontSize = 28 }: { label: string; fontSize?: number }) => {
  const initial = label.trim().slice(0, 1).toUpperCase() || "?";

  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        backgroundImage: "linear-gradient(135deg, #1d4ed8, #7c3aed)",
        color: "#dbeafe",
        fontSize: `${fontSize}px`,
        fontWeight: "800",
      }}
    >
      {initial}
    </div>
  );
};

const StarIcon = ({ size = 20 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="#3b82f6"
    style={{ display: "flex" }}
  >
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

type PopularGameCardItem = {
  name: string;
  imageUrl: string | null;
  players: string[];
};

// --- Simple Utility Helpers ---
function parseDurationHours(durationStr: string | undefined): string {
  if (!durationStr) return "0 ч";
  const hoursMatch = durationStr.match(/(\d+)H/);
  const minutesMatch = durationStr.match(/(\d+)M/);
  if (hoursMatch) {
    return `${hoursMatch[1]} ч`;
  }
  if (minutesMatch) {
    return `${minutesMatch[1]} мин`;
  }
  return "0 ч";
}

function getRelativeTimeStr(dateStr: string | null | undefined): string {
  if (!dateStr) return "неизвестно";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "давно";
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 60) return `${Math.max(1, minutes)} мин. назад`;
  if (hours < 24) return `${hours} ч. назад`;
  return `${days} дн. назад`;
}

function pluralizeRu(value: number, forms: [string, string, string]): string {
  const absolute = Math.abs(value);
  const lastTwo = absolute % 100;
  const last = absolute % 10;

  if (lastTwo >= 11 && lastTwo <= 14) {
    return forms[2];
  }

  if (last === 1) {
    return forms[0];
  }

  if (last >= 2 && last <= 4) {
    return forms[1];
  }

  return forms[2];
}

function getStatusBadge(status: string | undefined, currentGames: string[], lastOnline: string | null): { text: string; color: string; ringColor: string } {
  if (status === "playing") {
    return {
      text: `🎮 В игре: ${currentGames[0] || "играет"}`,
      color: "#06b6d4",
      ringColor: "#06b6d4",
    };
  }
  if (status === "online") {
    return {
      text: "🟢 В сети",
      color: "#10b981",
      ringColor: "#10b981",
    };
  }
  return {
    text: `🔘 Сеть: ${getRelativeTimeStr(lastOnline)}`,
    color: "#9ca3af",
    ringColor: "#4b5563",
  };
}

// --- Main Render Functions ---

export async function renderGamerCard(player: AggregatedPlayer, preferredSummary: PsnSummary): Promise<Uint8Array> {
  await initRenderer();

  // Fetch images in parallel
  const [avatarBase64, flagBase64, ...gamesBase64] = await Promise.all([
    fetchImageBase64(preferredSummary.avatarUrl),
    fetchImageBase64(preferredSummary.region?.code ? `https://flagcdn.com/w80/${preferredSummary.region.code.toLowerCase()}.png` : null),
    ...(preferredSummary.recentGamesRich || []).map((game) => fetchImageBase64(game.imageUrl)),
  ]);

  const finalAvatar = avatarBase64;

  const statusInfo = getStatusBadge(
    preferredSummary.presence.status,
    preferredSummary.presence.currentGames,
    preferredSummary.presence.lastOnline
  );

  const cardHtml = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#070b19",
        width: "800px",
        height: "550px",
        fontFamily: "Inter",
        color: "white",
        padding: "35px",
        borderRadius: "28px",
        backgroundImage: "radial-gradient(circle at 85% 15%, rgba(59, 130, 246, 0.18), transparent 50%), radial-gradient(circle at 15% 85%, rgba(139, 92, 246, 0.12), transparent 50%)",
        border: "1.5px solid rgba(255, 255, 255, 0.08)",
        boxSizing: "border-box",
      }}
    >
      {/* Profile Header Row */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: "25px", width: "100%" }}>
        {/* Avatar with Status Border */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "90px",
            height: "90px",
            borderRadius: "50%",
            border: `3px solid ${statusInfo.ringColor}`,
            boxShadow: `0 0 15px ${statusInfo.ringColor}44`,
            marginRight: "20px",
            overflow: "hidden",
          }}
        >
          {finalAvatar ? (
            <img
              src={finalAvatar}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          ) : (
            <AvatarPlaceholder label={preferredSummary.onlineId} fontSize={34} />
          )}
        </div>

        {/* Profile Info */}
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: "4px" }}>
            <span style={{ fontSize: "28px", fontWeight: "800", letterSpacing: "-0.5px", marginRight: "8px" }}>
              {preferredSummary.onlineId}
            </span>
            {preferredSummary.hasPlus && (
              <div style={{ display: "flex", marginRight: "10px" }}>
                <PlusIcon />
              </div>
            )}
            {flagBase64 && (
              <img
                src={flagBase64}
                style={{
                  width: "28px",
                  height: "18px",
                  borderRadius: "3px",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                }}
              />
            )}
            {!flagBase64 && preferredSummary.region?.code && (
              <span style={{ fontSize: "13px", color: "#93c5fd", fontWeight: "800" }}>
                {preferredSummary.region.code.toUpperCase()}
              </span>
            )}
          </div>
          <span style={{ fontSize: "16px", color: "#a5b4fc", fontWeight: "500", marginBottom: "4px" }}>
            {player.user.username ? `@${player.user.username}` : player.user.displayName}
          </span>
          <span style={{ fontSize: "14px", color: statusInfo.color, fontWeight: "600" }}>
            {statusInfo.text}
          </span>
        </div>
      </div>

      {/* Level Progress Panel */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          backgroundColor: "rgba(255, 255, 255, 0.03)",
          borderRadius: "16px",
          padding: "16px 20px",
          marginBottom: "25px",
          border: "1px solid rgba(255, 255, 255, 0.05)",
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <StarIcon />
            <span style={{ fontSize: "18px", fontWeight: "800", marginLeft: "8px", color: "#f3f4f6" }}>
              Уровень {player.level}
            </span>
          </div>
          <span style={{ fontSize: "15px", fontWeight: "700", color: "#3b82f6" }}>
            {player.progress}%
          </span>
        </div>
        {/* Progress Bar Container */}
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "8px",
            backgroundColor: "rgba(255,255,255,0.08)",
            borderRadius: "4px",
            overflow: "hidden",
          }}
        >
          {/* Active Gradient Bar */}
          <div
            style={{
              display: "flex",
              width: `${player.progress}%`,
              height: "100%",
              backgroundImage: "linear-gradient(to right, #3b82f6, #8b5cf6)",
              boxShadow: "0 0 8px rgba(59, 130, 246, 0.5)",
            }}
          />
        </div>
      </div>

      {/* Trophy Counts Panel */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "30px", width: "100%" }}>
        {(["platinum", "gold", "silver", "bronze"] as const).map((type) => {
          const labels = { platinum: "Платина", gold: "Золото", silver: "Серебро", bronze: "Бронза" };
          return (
            <div
              key={type}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                backgroundColor: "rgba(255, 255, 255, 0.02)",
                borderRadius: "16px",
                width: "165px",
                padding: "12px 10px",
                border: "1px solid rgba(255, 255, 255, 0.04)",
                boxSizing: "border-box",
              }}
            >
              <TrophyIcon type={type} size={40} />
              <span style={{ fontSize: "18px", fontWeight: "800", color: "white", marginTop: "8px", marginBottom: "2px" }}>
                {player.trophies[type]}
              </span>
              <span style={{ fontSize: "11px", color: "#9ca3af", fontWeight: "600", uppercase: true }}>
                {labels[type]}
              </span>
            </div>
          );
        })}
      </div>

      {/* Recently Played Games Section */}
      <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
        <span style={{ fontSize: "16px", fontWeight: "800", color: "#e5e7eb", marginBottom: "12px", letterSpacing: "0.5px" }}>
          НЕДАВНИЕ ИГРЫ
        </span>
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
          {Array.from({ length: 3 }).map((_, index) => {
            const game = (preferredSummary.recentGamesRich || [])[index];
            const gameImg = gamesBase64[index];

            if (!game) {
              return (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    backgroundColor: "rgba(255, 255, 255, 0.01)",
                    borderRadius: "12px",
                    width: "235px",
                    height: "70px",
                    border: "1px dashed rgba(255, 255, 255, 0.03)",
                    justifyContent: "center",
                  }}
                >
                  <span style={{ fontSize: "13px", color: "#4b5563" }}>Нет данных</span>
                </div>
              );
            }

            return (
              <div
                key={index}
                style={{
                  display: "flex",
                  alignItems: "center",
                  backgroundColor: "rgba(255, 255, 255, 0.02)",
                  borderRadius: "12px",
                  width: "235px",
                  height: "70px",
                  padding: "8px 10px",
                  border: "1px solid rgba(255, 255, 255, 0.03)",
                  boxSizing: "border-box",
                }}
              >
                {/* Game Thumbnail */}
                <div
                  style={{
                    display: "flex",
                    width: "40px",
                    height: "54px",
                    borderRadius: "6px",
                    backgroundColor: "#1e293b",
                    overflow: "hidden",
                    marginRight: "12px",
                  }}
                >
                  {gameImg ? (
                    <img src={gameImg} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <div style={{ display: "flex", width: "100%", height: "100%", backgroundColor: "#334155" }} />
                  )}
                </div>

                {/* Game Info */}
                <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, overflow: "hidden" }}>
                  <span
                    style={{
                      fontSize: "13px",
                      fontWeight: "700",
                      color: "white",
                      marginBottom: "4px",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      width: "160px",
                    }}
                  >
                    {game.name}
                  </span>
                  <span style={{ fontSize: "12px", color: "#3b82f6", fontWeight: "600" }}>
                    {parseDurationHours(game.playDuration)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  const svg = await satori(cardHtml, {
    width: CARD_LOGICAL_WIDTH,
    height: 550,
    fonts: [
      {
        name: "Inter",
        data: fontRegularBuffer!,
        weight: 400,
        style: "normal",
      },
      {
        name: "Inter",
        data: fontBoldBuffer!,
        weight: 800,
        style: "normal",
      },
    ],
  });

  const resvg = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: RENDER_OUTPUT_WIDTH,
    },
  });

  const pngData = resvg.render();
  return pngData.asPng();
}

export async function renderLeaderboard(players: AggregatedPlayer[]): Promise<Uint8Array> {
  await initRenderer();

  const rowHeight = 90;
  const headerHeight = 110;
  const bottomMargin = 40;
  const calculatedHeight = headerHeight + players.length * rowHeight + bottomMargin;

  // Parallel pre-fetching of all player avatars and flags
  const avatarsAndFlags = await Promise.all(
    players.map(async (player) => {
      const summary = player.accountSummaries[0];
      const avatarUrl = summary?.avatarUrl;
      const regionCode = summary?.region?.code;
      const [avatar, flag] = await Promise.all([
        fetchImageBase64(avatarUrl),
        fetchImageBase64(regionCode ? `https://flagcdn.com/w80/${regionCode.toLowerCase()}.png` : null),
      ]);
      return { avatar, flag, regionCode };
    })
  );

  const leaderboardHtml = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#070b19",
        width: "800px",
        height: `${calculatedHeight}px`,
        fontFamily: "Inter",
        color: "white",
        padding: "35px",
        borderRadius: "28px",
        backgroundImage: "radial-gradient(circle at 50% 10%, rgba(59, 130, 246, 0.15), transparent 50%), radial-gradient(circle at 10% 90%, rgba(139, 92, 246, 0.08), transparent 50%)",
        border: "1.5px solid rgba(255, 255, 255, 0.08)",
        boxSizing: "border-box",
      }}
    >
      {/* Header section */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", marginBottom: "30px" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: "6px" }}>
          <CrownIcon size={34} />
          <span
            style={{
              fontSize: "30px",
              fontWeight: "800",
              marginLeft: "10px",
              letterSpacing: "1px",
              backgroundImage: "linear-gradient(to right, #3b82f6, #60a5fa)",
              backgroundClip: "text",
              color: "white",
            }}
          >
            BUDKA PSN LEADERBOARD
          </span>
        </div>
        <span style={{ fontSize: "14px", color: "#a5b4fc", fontWeight: "600", letterSpacing: "1.5px" }}>
          ТАБЛИЦА ЛИДЕРОВ ГРУППЫ
        </span>
      </div>

      {/* Header Columns labels */}
      <div
        style={{
          display: "flex",
          width: "100%",
          padding: "0 25px 8px 25px",
          borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
          fontSize: "12px",
          color: "#4b5563",
          fontWeight: "800",
          letterSpacing: "1px",
          boxSizing: "border-box",
        }}
      >
        <span style={{ width: "70px", display: "flex" }}>РАНГ</span>
        <span style={{ width: "260px", display: "flex" }}>ИГРОК</span>
        <span style={{ width: "120px", display: "flex" }}>УРОВЕНЬ</span>
        <span style={{ width: "230px", display: "flex", justifyContent: "flex-end" }}>ТРОФЕИ</span>
      </div>

      {/* Players Rows */}
      <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
        {players.map((player, index) => {
          const rank = index + 1;
          const { avatar, flag, regionCode } = avatarsAndFlags[index];
          const finalAvatar = avatar;
          const isFirst = rank === 1;

          let rankBadge = null;
          if (rank === 1) {
            rankBadge = <CrownIcon size={24} />;
          } else if (rank === 2) {
            rankBadge = (
              <div
                style={{
                  display: "flex",
                  width: "24px",
                  height: "24px",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "50%",
                  backgroundColor: "#9ca3af",
                  border: "1px solid #78716c",
                  color: "#1f2937",
                  fontSize: "12px",
                  fontWeight: "800",
                }}
              >
                2
              </div>
            );
          } else if (rank === 3) {
            rankBadge = (
              <div
                style={{
                  display: "flex",
                  width: "24px",
                  height: "24px",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "50%",
                  backgroundColor: "#b45309",
                  border: "1px solid #7c2d12",
                  color: "#fef3c7",
                  fontSize: "12px",
                  fontWeight: "800",
                }}
              >
                3
              </div>
            );
          } else {
            rankBadge = (
              <span style={{ fontSize: "16px", fontWeight: "800", color: "#4b5563" }}>
                {rank}
              </span>
            );
          }

          return (
            <div
              key={player.user.userId}
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                height: "76px",
                padding: "0 25px",
                backgroundColor: isFirst ? "rgba(251, 191, 36, 0.03)" : "rgba(255, 255, 255, 0.01)",
                borderRadius: "16px",
                border: isFirst ? "1.5px solid rgba(251, 191, 36, 0.25)" : "1px solid rgba(255, 255, 255, 0.03)",
                marginTop: "12px",
                boxSizing: "border-box",
                boxShadow: isFirst ? "0 4px 15px rgba(251, 191, 36, 0.05)" : "none",
              }}
            >
              {/* Column 1: Rank */}
              <div style={{ width: "70px", display: "flex", alignItems: "center" }}>
                {rankBadge}
              </div>

              {/* Column 2: Player Profile */}
              <div style={{ width: "260px", display: "flex", alignItems: "center" }}>
                <div
                  style={{
                    display: "flex",
                    width: "44px",
                    height: "44px",
                    borderRadius: "50%",
                    border: isFirst ? "2px solid #facc15" : "1.5px solid rgba(255,255,255,0.1)",
                    overflow: "hidden",
                    marginRight: "14px",
                  }}
                >
                  {finalAvatar ? (
                    <img src={finalAvatar} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <AvatarPlaceholder label={player.user.displayName} fontSize={18} />
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", width: "170px" }}>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <span
                      style={{
                        fontSize: "15px",
                        fontWeight: "800",
                        color: "white",
                        marginRight: "6px",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {player.user.displayName}
                    </span>
                    {flag && (
                      <img src={flag} style={{ width: "18px", height: "12px", borderRadius: "1.5px" }} />
                    )}
                    {!flag && regionCode && (
                      <span style={{ fontSize: "10px", color: "#93c5fd", fontWeight: "800" }}>
                        {regionCode.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "#6b7280",
                      fontWeight: "500",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {player.accountSummaries[0]?.onlineId || player.user.username || ""}
                  </span>
                </div>
              </div>

              {/* Column 3: Level */}
              <div style={{ width: "120px", display: "flex", alignItems: "center" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    backgroundColor: isFirst ? "rgba(251, 191, 36, 0.1)" : "rgba(59, 130, 246, 0.08)",
                    border: isFirst ? "1px solid rgba(251, 191, 36, 0.2)" : "1px solid rgba(59, 130, 246, 0.15)",
                    borderRadius: "8px",
                    padding: "4px 10px",
                  }}
                >
                  <span style={{ fontSize: "14px", fontWeight: "800", color: isFirst ? "#facc15" : "#60a5fa" }}>
                    {player.level}
                  </span>
                </div>
              </div>

              {/* Column 4: Trophies summary */}
              <div style={{ width: "230px", display: "flex", justifyContent: "flex-end", alignItems: "center" }}>
                {(["platinum", "gold", "silver", "bronze"] as const).map((type, tIndex) => (
                  <div
                    key={type}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      marginLeft: tIndex > 0 ? "14px" : "0",
                    }}
                  >
                    <TrophyIcon type={type} size={24} />
                    <span style={{ fontSize: "14px", fontWeight: "700", color: "white", marginLeft: "4px" }}>
                      {player.trophies[type]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const svg = await satori(leaderboardHtml, {
    width: CARD_LOGICAL_WIDTH,
    height: calculatedHeight,
    fonts: [
      {
        name: "Inter",
        data: fontRegularBuffer!,
        weight: 400,
        style: "normal",
      },
      {
        name: "Inter",
        data: fontBoldBuffer!,
        weight: 800,
        style: "normal",
      },
    ],
  });

  const resvg = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: RENDER_OUTPUT_WIDTH,
    },
  });

  const pngData = resvg.render();
  return pngData.asPng();
}

export async function renderPopularGames(games: PopularGameCardItem[]): Promise<Uint8Array> {
  await initRenderer();

  const topGames = games.slice(0, 5);
  const maxPlayers = Math.max(1, ...topGames.map((game) => game.players.length));
  const headerHeight = 170;
  const bottomMargin = 34;
  const rowMarginBottom = 18;
  const baseRowHeight = 78;
  const pillLineHeight = 22;
  const playerColumnWidth = 345;
  const pillLinesByGame = topGames.map((game) =>
    estimatePillLines(game.players, playerColumnWidth),
  );
  const rowHeights = pillLinesByGame.map(
    (lines) => baseRowHeight + Math.max(0, lines - 1) * pillLineHeight,
  );
  const calculatedHeight =
    headerHeight +
    rowHeights.reduce((sum, h) => sum + h + rowMarginBottom, 0) +
    bottomMargin;
  const covers = await Promise.all(topGames.map((game) => fetchImageBase64(game.imageUrl)));
  const pillColors = ["#2563eb", "#059669", "#b45309", "#9333ea", "#be123c"];

  const popularHtml = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#070b19",
        width: "800px",
        height: `${calculatedHeight}px`,
        fontFamily: "Inter",
        color: "white",
        padding: "34px 42px",
        borderRadius: "28px",
        backgroundImage: "radial-gradient(circle at 12% 8%, rgba(14, 165, 233, 0.22), transparent 42%), radial-gradient(circle at 88% 24%, rgba(168, 85, 247, 0.18), transparent 38%), radial-gradient(circle at 82% 96%, rgba(59, 130, 246, 0.20), transparent 42%)",
        border: "1.5px solid rgba(255, 255, 255, 0.08)",
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", marginBottom: "28px" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: "4px" }}>
          <span
            style={{
              fontSize: "42px",
              fontWeight: "800",
              color: "#dbeafe",
              marginRight: "14px",
            }}
          >
            BUDKA POPULAR GAMES
          </span>
          <CrownIcon size={38} />
        </div>
        <span style={{ fontSize: "15px", color: "#a5b4fc", fontWeight: "700", letterSpacing: "0px" }}>
          ПОПУЛЯРНЫЕ ИГРЫ ГРУППЫ
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
        {topGames.map((game, index) => {
          const rank = index + 1;
          const cover = covers[index];
          const players = game.players;
          const popularity = Math.max(10, Math.round((game.players.length / maxPlayers) * 100));
          const rowHeight = rowHeights[index];

          return (
            <div
              key={`${game.name}-${rank}`}
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                height: `${rowHeight}px`,
                padding: "10px 18px",
                backgroundColor: rank === 1 ? "rgba(251, 191, 36, 0.045)" : "rgba(255, 255, 255, 0.025)",
                border: rank === 1 ? "1.5px solid rgba(251, 191, 36, 0.28)" : "1px solid rgba(147, 197, 253, 0.16)",
                borderRadius: "14px",
                marginBottom: `${rowMarginBottom}px`,
                boxSizing: "border-box",
              }}
            >
              <div
                style={{
                  display: "flex",
                  width: "54px",
                  height: "54px",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "50%",
                  backgroundImage: rank === 1
                    ? "linear-gradient(135deg, #facc15, #fb923c)"
                    : "linear-gradient(135deg, #22d3ee, #8b5cf6)",
                  color: rank === 1 ? "#422006" : "#eff6ff",
                  fontSize: "24px",
                  fontWeight: "800",
                  border: rank === 1 ? "2px solid #fde68a" : "2px solid #67e8f9",
                  marginRight: "18px",
                }}
              >
                {rank}
              </div>

              <div
                style={{
                  display: "flex",
                  width: "56px",
                  height: "56px",
                  borderRadius: "9px",
                  backgroundColor: "#111827",
                  overflow: "hidden",
                  marginRight: "22px",
                  border: "1px solid rgba(255, 255, 255, 0.08)",
                }}
              >
                {cover ? (
                  <img src={cover} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <AvatarPlaceholder label={game.name} fontSize={22} />
                )}
              </div>

              <div style={{ display: "flex", flexDirection: "column", width: `${playerColumnWidth}px`, marginRight: "22px" }}>
                <span
                  style={{
                    fontSize: "22px",
                    fontWeight: "800",
                    color: "#f8fafc",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    marginBottom: "8px",
                  }}
                >
                  {game.name}
                </span>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", width: "100%" }}>
                  {players.map((player, playerIndex) => (
                    <div
                      key={`${game.name}-${player}`}
                      style={{
                        display: "flex",
                        padding: "3px 8px",
                        borderRadius: "12px",
                        backgroundColor: pillColors[playerIndex % pillColors.length],
                        color: "#e0f2fe",
                        fontSize: "11px",
                        fontWeight: "700",
                        marginRight: "6px",
                        marginBottom: "4px",
                      }}
                    >
                      <span style={{ whiteSpace: "nowrap" }}>
                        {player}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, alignItems: "flex-end" }}>
                <span style={{ fontSize: "12px", color: "#c4b5fd", fontWeight: "700", marginBottom: "8px" }}>
                  Популярность
                </span>
                <div
                  style={{
                    display: "flex",
                    width: "140px",
                    height: "9px",
                    backgroundColor: "rgba(148, 163, 184, 0.22)",
                    borderRadius: "5px",
                    overflow: "hidden",
                    marginBottom: "8px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      width: `${popularity}%`,
                      height: "100%",
                      backgroundImage: "linear-gradient(to right, #38bdf8, #8b5cf6)",
                    }}
                  />
                </div>
                <span style={{ fontSize: "13px", color: "#cbd5e1", fontWeight: "700" }}>
                  {game.players.length} {pluralizeRu(game.players.length, ["участник", "участника", "участников"])}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const svg = await satori(popularHtml, {
    width: CARD_LOGICAL_WIDTH,
    height: calculatedHeight,
    fonts: [
      {
        name: "Inter",
        data: fontRegularBuffer!,
        weight: 400,
        style: "normal",
      },
      {
        name: "Inter",
        data: fontBoldBuffer!,
        weight: 800,
        style: "normal",
      },
    ],
  });

  const resvg = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: RENDER_OUTPUT_WIDTH,
    },
  });

  const pngData = resvg.render();
  return pngData.asPng();
}
