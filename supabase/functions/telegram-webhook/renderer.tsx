// @ts-nocheck
/** @jsx h */
/** @jsxFrag Fragment */
import satori from "npm:satori@0.13.0";
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import type { PsnSummary, PsnPlayedGameRich } from "./psn.ts";
import type { AggregatedPlayer } from "./bot.ts";

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

// --- Cache for WASM and Fonts ---
let isWasmInit = false;
let fontRegularBuffer: ArrayBuffer | null = null;
let fontBoldBuffer: ArrayBuffer | null = null;

async function readAsset(path: string): Promise<ArrayBuffer> {
  try {
    const bytes = await Deno.readFile(new URL(path, import.meta.url));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } catch (error) {
    throw new Error(`Failed to read renderer asset ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertOpenTypeAsset(name: string, buffer: ArrayBuffer) {
  const signature = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 4)));
  const validSignatures = new Set(["\x00\x01\x00\x00", "OTTO", "ttcf", "wOFF"]);

  if (!validSignatures.has(signature)) {
    throw new Error(`Invalid font asset ${name}: unsupported OpenType signature ${JSON.stringify(signature)}`);
  }
}

async function initRenderer() {
  if (!isWasmInit) {
    const wasmBuffer = await readAsset("./assets/resvg.wasm");
    await initWasm(wasmBuffer);
    isWasmInit = true;
  }

  if (!fontRegularBuffer) {
    fontRegularBuffer = await readAsset("./assets/Inter-Regular.ttf");
    assertOpenTypeAsset("Inter-Regular.ttf", fontRegularBuffer);
  }

  if (!fontBoldBuffer) {
    fontBoldBuffer = await readAsset("./assets/Inter-Bold.ttf");
    assertOpenTypeAsset("Inter-Bold.ttf", fontBoldBuffer);
  }
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

// --- Vector SVGs for UI ---
const TrophyIcon = ({ type, size = 20 }: { type: "platinum" | "gold" | "silver" | "bronze"; size?: number }) => {
  const fillColors = {
    platinum: "#4facfe",
    gold: "#ffb300",
    silver: "#b0bec5",
    bronze: "#a1887f",
  };
  const strokeColors = {
    platinum: "#00f2fe",
    gold: "#ffe082",
    silver: "#eceff1",
    bronze: "#d7ccc8",
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={strokeColors[type]}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "flex" }}
    >
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" fill={fillColors[type]} opacity="0.4" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" fill={fillColors[type]} opacity="0.4" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.45 1-1 1H4v2h16v-2h-5c-.55 0-1-.45-1-1v-2.34" />
      <path
        d="M12 2a6 6 0 0 0-6 6v3.5c0 1.63 1.3 3.32 3.5 3.5h5c2.2-.18 3.5-1.87 3.5-3.5V8a6 6 0 0 0-6-6z"
        fill={fillColors[type]}
      />
    </svg>
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
              <TrophyIcon type={type} size={28} />
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
    width: 800,
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
      value: 800,
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
              <svg width="24" height="24" viewBox="0 0 24 24" fill="#9ca3af" style={{ display: "flex" }}>
                <circle cx="12" cy="12" r="10" stroke="#78716c" strokeWidth="1" />
                <text x="12" y="16" fontSize="12" fontWeight="800" textAnchor="middle" fill="#1f2937">2</text>
              </svg>
            );
          } else if (rank === 3) {
            rankBadge = (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="#b45309" style={{ display: "flex" }}>
                <circle cx="12" cy="12" r="10" stroke="#7c2d12" strokeWidth="1" />
                <text x="12" y="16" fontSize="12" fontWeight="800" textAnchor="middle" fill="#fef3c7">3</text>
              </svg>
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
                    <TrophyIcon type={type} size={18} />
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
    width: 800,
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
      value: 800,
    },
  });

  const pngData = resvg.render();
  return pngData.asPng();
}
