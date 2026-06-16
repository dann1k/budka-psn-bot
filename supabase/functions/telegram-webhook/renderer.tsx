// @ts-nocheck
/** @jsx h */
/** @jsxFrag Fragment */
import satori from "npm:satori@0.13.0";
// resvg (SVG→PNG) is loaded dynamically — native @resvg/resvg-js with a wasm
// fallback. See initResvg().
import type { PsnSummary } from "./psn.ts";
import type { AggregatedPlayer } from "./bot.ts";
import {
  getManropeRegularBuffer,
  getManropeBoldBuffer,
  getManropeExtraBoldBuffer,
  getSpaceMonoBoldBuffer,
  getPlayStationPlusImageDataUrl,
  getResvgWasmBuffer,
  getTrophyImageDataUrl,
  preloadPlayStationPlusImage,
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

// --- "PS5 Минимал" light design tokens ---
// All three cards share this palette: white rounded cards floating on a light
// page, PlayStation-blue accents, Manrope body + Space Mono for the few Latin
// monospace accents (rank digits, cover abbreviations).
const FONT_SANS = "Manrope";
const FONT_MONO = "Space Mono";

const PAGE_BG = "#eceef1"; // light frame behind the card → makes the rounded corners + shadow read
const CARD_BG = "#ffffff";
const CARD_BORDER = "#e6e9ee";
// Soft drop shadow exactly as in the design mockup. resvg's Gaussian blur is
// expensive (cost ~proportional to the blurred area, not the radius), which is
// why it was dropped while the bot ran on Supabase Edge (~2s CPU cap). Self-hosted
// on a VPS there's no such cap, so the mockup's floating-card look is restored.
const CARD_SHADOW = "0 14px 34px rgba(15,30,60,0.08)";
const CARD_RADIUS = 22;

const INK = "#0a1020"; // primary headings / numbers
const INK_SOFT = "#3a4452"; // trophy counts
const MUTED = "#6b7280"; // secondary text
const LABEL = "#9aa3b0"; // small uppercase labels
const LABEL_DIM = "#aab2bd"; // column headers
const RANK_REST = "#b3bbc5"; // rank number for places 4+

const BLUE = "#0070d1";
const BLUE_GRAD_135 = "linear-gradient(135deg,#0070d1,#39c0ff)"; // avatars
const BLUE_GRAD_RIGHT = "linear-gradient(to right,#0070d1,#39c0ff)"; // progress / popularity bars

const PANEL_BG = "#f7f9fb"; // trophy + game cells, popular rows
const PANEL_BORDER = "#eceff3";
const LEVEL_BG = "#f3f6f9";
const LEVEL_BORDER = "#eaeef3";
const CHIP_BG = "#eef3f9"; // region + level chips
const PILL_TEXT = "#3a6ea5"; // popular player pills
const TRACK = "#e2e8f0"; // progress / popularity track
const COVER_BG = "#e8edf3"; // game cover placeholder
const COVER_TEXT = "#8794a5";

// Logical layout width used by Satori for all cards. Resvg then rasterizes the SVG
// at `width * scale` px. Self-hosted on a VPS there's no Edge CPU cap, so every
// card upscales for crisp text/icons; embedded images (avatars 240–512px, trophy
// PNGs 240px, covers ~512px) all out-resolve their on-card size at 2×, so they
// stay sharp. The only ceiling is Telegram's sendPhoto limit (width + height must
// stay under 10000 px), which auto-shrinks only pathologically tall tables.
// Per-response scaleMultiplier (config/features.json → renderScale.*) multiplies
// the base scale, so the operator can push resolution further per card type.
const CARD_LOGICAL_WIDTH = 800;
const SUMMARY_RENDER_SCALE = 2.0; // fixed-size summary card
const GROWABLE_RENDER_SCALE = 2.0; // leaderboard + popular (grow with chat size)
const TELEGRAM_MAX_DIMENSION_SUM = 9000; // keep width + height < 10000 for sendPhoto

// Outer light frame so the white card's rounded corners + shadow are visible.
const OUTER_PAD = 28;
const CARD_PAD = 30;

// Output width = logicalWidth × baseScale × scaleMultiplier, shrunk only if the
// resulting width + height would breach Telegram's photo dimension limit (so a
// huge leaderboard still sends instead of being rejected).
function computeOutputWidth(
  logicalWidth: number,
  logicalHeight: number,
  baseScale: number,
  scaleMultiplier = 1
): number {
  const targetScale = baseScale * scaleMultiplier;
  const telegramMaxScale = TELEGRAM_MAX_DIMENSION_SUM / (logicalWidth + logicalHeight);
  const scale = Math.min(targetScale, telegramMaxScale);
  return Math.max(1, Math.round(logicalWidth * scale));
}

// Rough estimate of how many wrapped lines a row of player pills will take,
// given Satori-rendered Manrope Bold 11px pills with 9px horizontal padding
// and 5px gap between pills. Slightly overestimates per-char width so the
// computed row height never clips the pills.
const PILL_AVG_CHAR_WIDTH = 7;
const PILL_HORIZONTAL_PADDING = 18;
const PILL_GAP = 5;

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
// --- Rasterizer (SVG → PNG) ---
// Prefer native @resvg/resvg-js: same resvg engine as the wasm build, so output
// is pixel-identical, but ~3–4× faster on the blur-heavy cards (measured). If the
// native napi addon can't load on the host (or RESVG_FORCE_WASM=1), transparently
// fall back to resvg-wasm so the bot keeps rendering anywhere.
let ResvgClass: any = null;
let usingNativeResvg = false;

async function initResvg(): Promise<void> {
  if (ResvgClass) return;

  if (Deno.env.get("RESVG_FORCE_WASM") !== "1") {
    try {
      const native = await import("npm:@resvg/resvg-js@2.6.2");
      ResvgClass = native.Resvg;
      usingNativeResvg = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[renderer] native resvg unavailable (${message}); falling back to wasm`);
    }
  }

  if (!ResvgClass) {
    const { initWasm, Resvg } = await import("npm:@resvg/resvg-wasm@2.6.2");
    await initWasm(await getResvgWasmBuffer());
    ResvgClass = Resvg;
    usingNativeResvg = false;
  }

  // Warm the backend so the first real card isn't penalized by lazy napi/wasm init.
  try {
    rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>', 2);
  } catch {
    /* best-effort warm-up */
  }
  console.log(`[renderer] resvg backend: ${usingNativeResvg ? "native @resvg/resvg-js" : "wasm"}`);
}

function rasterize(svg: string, outputWidth: number): Uint8Array {
  const resvg = new ResvgClass(svg, { fitTo: { mode: "width", value: outputWidth } });
  return resvg.render().asPng();
}
let manropeRegularBuffer: ArrayBuffer | null = null;
let manropeBoldBuffer: ArrayBuffer | null = null;
let manropeExtraBoldBuffer: ArrayBuffer | null = null;
let spaceMonoBoldBuffer: ArrayBuffer | null = null;

function assertOpenTypeAsset(name: string, buffer: ArrayBuffer) {
  const signature = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 4)));
  const validSignatures = new Set(["\x00\x01\x00\x00", "OTTO", "ttcf", "wOFF"]);

  if (!validSignatures.has(signature)) {
    throw new Error(`Invalid font asset ${name}: unsupported OpenType signature ${JSON.stringify(signature)}`);
  }
}

async function initRenderer() {
  await initResvg();

  if (!manropeRegularBuffer) {
    manropeRegularBuffer = await getManropeRegularBuffer();
    assertOpenTypeAsset("Manrope-Regular.ttf", manropeRegularBuffer);
  }

  if (!manropeBoldBuffer) {
    manropeBoldBuffer = await getManropeBoldBuffer();
    assertOpenTypeAsset("Manrope-Bold.ttf", manropeBoldBuffer);
  }

  if (!manropeExtraBoldBuffer) {
    manropeExtraBoldBuffer = await getManropeExtraBoldBuffer();
    assertOpenTypeAsset("Manrope-ExtraBold.ttf", manropeExtraBoldBuffer);
  }

  if (!spaceMonoBoldBuffer) {
    spaceMonoBoldBuffer = await getSpaceMonoBoldBuffer();
    assertOpenTypeAsset("SpaceMono-Bold.ttf", spaceMonoBoldBuffer);
  }

  await preloadTrophyImages();
}

// Satori font set. Manrope carries Cyrillic at 400/700/800; Space Mono is
// registered at 700 only and used solely for Latin/numeric accents, so its lack
// of Cyrillic never surfaces. Requested weights snap to the nearest registered
// one (e.g. Manrope 600 → 700, Space Mono 800 → 700).
function getFontConfig() {
  return [
    { name: FONT_SANS, data: manropeRegularBuffer!, weight: 400, style: "normal" },
    { name: FONT_SANS, data: manropeBoldBuffer!, weight: 700, style: "normal" },
    { name: FONT_SANS, data: manropeExtraBoldBuffer!, weight: 800, style: "normal" },
    { name: FONT_MONO, data: spaceMonoBoldBuffer!, weight: 700, style: "normal" },
  ];
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
  <img
    src={getPlayStationPlusImageDataUrl()}
    style={{
      display: "flex",
      width: `${size}px`,
      height: `${size}px`,
      objectFit: "contain",
    }}
  />
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
        backgroundImage: BLUE_GRAD_135,
        color: "#ffffff",
        fontSize: `${fontSize}px`,
        fontWeight: "800",
      }}
    >
      {initial}
    </div>
  );
};

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

// Short uppercase abbreviation for a game-cover placeholder (shown only when the
// real cover image is missing). "EA SPORTS FC 25" → "EASF", "Helldivers 2" → "HE".
function gameAbbr(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "—";
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .slice(0, 4)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function getStatusBadge(
  status: string | undefined,
  currentGames: string[],
  lastOnline: string | null,
): { text: string; color: string } {
  if (status === "playing") {
    return { text: `В игре · ${currentGames[0] || "играет"}`, color: BLUE };
  }
  if (status === "online") {
    return { text: "В сети", color: "#16a34a" };
  }
  return { text: `Сеть · ${getRelativeTimeStr(lastOnline)}`, color: LABEL };
}

// Outer light frame wrapping a white rounded card. Shared by all three cards.
const CardFrame = ({ height, children }: { height: number; children: any }) => (
  <div
    style={{
      display: "flex",
      width: `${CARD_LOGICAL_WIDTH}px`,
      height: `${height}px`,
      padding: `${OUTER_PAD}px`,
      backgroundColor: PAGE_BG,
      fontFamily: FONT_SANS,
      boxSizing: "border-box",
    }}
  >
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        backgroundColor: CARD_BG,
        border: `1px solid ${CARD_BORDER}`,
        borderRadius: `${CARD_RADIUS}px`,
        boxShadow: CARD_SHADOW,
        padding: `${CARD_PAD}px`,
        color: INK,
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  </div>
);

// --- Main Render Functions ---

export async function renderGamerCard(player: AggregatedPlayer, preferredSummary: PsnSummary, scaleMultiplier = 1): Promise<Uint8Array> {
  await initRenderer();
  if (preferredSummary.hasPlus) {
    await preloadPlayStationPlusImage();
  }

  // Fetch avatar + recent-game covers in parallel.
  const [avatarBase64, ...gamesBase64] = await Promise.all([
    fetchImageBase64(preferredSummary.avatarUrl),
    ...(preferredSummary.recentGamesRich || []).map((game) => fetchImageBase64(game.imageUrl)),
  ]);

  const statusInfo = getStatusBadge(
    preferredSummary.presence.status,
    preferredSummary.presence.currentGames,
    preferredSummary.presence.lastOnline,
  );

  // Deterministic layout heights → fixed card height with no clipping.
  const HEADER_H = 84;
  const HEADER_MB = 22;
  const LEVEL_H = 78;
  const LEVEL_MB = 16;
  const TROPHY_H = 104;
  const TROPHY_MB = 18;
  const GAMES_LABEL_H = 16;
  const GAMES_LABEL_MB = 10;
  const GAME_CELL_H = 72;
  const cardInnerHeight =
    HEADER_H + HEADER_MB + LEVEL_H + LEVEL_MB + TROPHY_H + TROPHY_MB + GAMES_LABEL_H + GAMES_LABEL_MB + GAME_CELL_H;
  const summaryHeight = cardInnerHeight + CARD_PAD * 2 + OUTER_PAD * 2;

  const trophyLabels = { platinum: "ПЛАТИНА", gold: "ЗОЛОТО", silver: "СЕРЕБРО", bronze: "БРОНЗА" };

  const cardHtml = (
    <CardFrame height={summaryHeight}>
      {/* Profile Header Row */}
      <div style={{ display: "flex", alignItems: "center", width: "100%", height: `${HEADER_H}px`, marginBottom: `${HEADER_MB}px` }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "82px",
            height: "82px",
            borderRadius: "50%",
            overflow: "hidden",
            marginRight: "18px",
            boxShadow: "0 6px 16px rgba(0,112,209,0.35)",
          }}
        >
          {avatarBase64 ? (
            <img src={avatarBase64} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <AvatarPlaceholder label={preferredSummary.onlineId} fontSize={34} />
          )}
        </div>

        {/* Profile Info */}
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: "4px" }}>
            <span style={{ fontSize: "26px", fontWeight: "800", color: INK, letterSpacing: "-0.5px", marginRight: "9px" }}>
              {preferredSummary.onlineId}
            </span>
            {preferredSummary.hasPlus && (
              <div style={{ display: "flex", marginRight: "9px" }}>
                <PlusIcon size={22} />
              </div>
            )}
            {preferredSummary.region?.code && (
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "2px 8px",
                  borderRadius: "6px",
                  backgroundColor: CHIP_BG,
                  color: BLUE,
                  fontSize: "12px",
                  fontWeight: "700",
                }}
              >
                {preferredSummary.region.code.toUpperCase()}
              </span>
            )}
          </div>
          <span style={{ fontSize: "15px", color: MUTED, fontWeight: "600", marginBottom: "5px" }}>
            {player.user.username ? `@${player.user.username}` : player.user.displayName}
          </span>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                display: "flex",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: statusInfo.color,
                marginRight: "7px",
              }}
            />
            <span style={{ fontSize: "14px", color: statusInfo.color, fontWeight: "700" }}>
              {statusInfo.text}
            </span>
          </div>
        </div>
      </div>

      {/* Level Progress Panel */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          backgroundColor: LEVEL_BG,
          borderRadius: "16px",
          height: `${LEVEL_H}px`,
          padding: "0 20px",
          marginBottom: `${LEVEL_MB}px`,
          border: `1px solid ${LEVEL_BORDER}`,
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", width: "100%" }}>
          <span style={{ fontSize: "17px", fontWeight: "800", color: INK }}>
            Уровень {player.level}
          </span>
          <span style={{ fontSize: "15px", fontWeight: "800", color: BLUE }}>
            {player.progress}%
          </span>
        </div>
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "8px",
            backgroundColor: TRACK,
            borderRadius: "5px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              width: `${player.progress}%`,
              height: "100%",
              backgroundImage: BLUE_GRAD_RIGHT,
            }}
          />
        </div>
      </div>

      {/* Trophy Counts */}
      <div style={{ display: "flex", justifyContent: "space-between", height: `${TROPHY_H}px`, marginBottom: `${TROPHY_MB}px`, width: "100%" }}>
        {(["platinum", "gold", "silver", "bronze"] as const).map((type) => (
          <div
            key={type}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: PANEL_BG,
              borderRadius: "14px",
              width: "162px",
              height: "100%",
              border: `1px solid ${PANEL_BORDER}`,
              boxSizing: "border-box",
            }}
          >
            <TrophyIcon type={type} size={38} />
            <span style={{ fontSize: "19px", fontWeight: "800", color: INK, marginTop: "6px", marginBottom: "3px" }}>
              {player.trophies[type]}
            </span>
            <span style={{ fontSize: "10px", color: LABEL, fontWeight: "700", letterSpacing: "0.4px" }}>
              {trophyLabels[type]}
            </span>
          </div>
        ))}
      </div>

      {/* Recently Played Games */}
      <span
        style={{
          fontSize: "12px",
          fontWeight: "700",
          color: LABEL,
          letterSpacing: "1.5px",
          height: `${GAMES_LABEL_H}px`,
          marginBottom: `${GAMES_LABEL_MB}px`,
        }}
      >
        НЕДАВНИЕ ИГРЫ
      </span>
      <div style={{ display: "flex", justifyContent: "space-between", width: "100%", height: `${GAME_CELL_H}px` }}>
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
                  justifyContent: "center",
                  backgroundColor: PANEL_BG,
                  borderRadius: "12px",
                  width: "220px",
                  height: "100%",
                  border: `1px dashed ${PANEL_BORDER}`,
                  boxSizing: "border-box",
                }}
              >
                <span style={{ fontSize: "12px", color: LABEL }}>Нет данных</span>
              </div>
            );
          }

          return (
            <div
              key={index}
              style={{
                display: "flex",
                alignItems: "center",
                backgroundColor: PANEL_BG,
                borderRadius: "12px",
                width: "220px",
                height: "100%",
                padding: "0 11px",
                border: `1px solid ${PANEL_BORDER}`,
                boxSizing: "border-box",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "42px",
                  height: "56px",
                  borderRadius: "7px",
                  backgroundColor: COVER_BG,
                  overflow: "hidden",
                  marginRight: "11px",
                }}
              >
                {gameImg ? (
                  <img src={gameImg} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <span style={{ fontSize: "9px", fontWeight: "700", color: COVER_TEXT, fontFamily: FONT_MONO }}>
                    {gameAbbr(game.name)}
                  </span>
                )}
              </div>

              <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, overflow: "hidden" }}>
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: "700",
                    color: INK,
                    marginBottom: "3px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    width: "138px",
                  }}
                >
                  {game.name}
                </span>
                <span style={{ fontSize: "12px", color: BLUE, fontWeight: "700" }}>
                  {parseDurationHours(game.playDuration)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </CardFrame>
  );

  const svg = await satori(cardHtml, {
    width: CARD_LOGICAL_WIDTH,
    height: summaryHeight,
    fonts: getFontConfig(),
  });

  const outputWidth = computeOutputWidth(CARD_LOGICAL_WIDTH, summaryHeight, SUMMARY_RENDER_SCALE, scaleMultiplier);
  const png = rasterize(svg, outputWidth);
  console.log(`[summary-render] scale=${scaleMultiplier} outW=${outputWidth}`);
  return png;
}

export async function renderLeaderboard(players: AggregatedPlayer[], scaleMultiplier = 1): Promise<Uint8Array> {
  await initRenderer();

  const HEADER_H = 64;
  const COL_HEADER_H = 24;
  const ROW_H = 64;
  const BOTTOM_PAD = 6;
  const calculatedHeight =
    OUTER_PAD * 2 + CARD_PAD * 2 + HEADER_H + COL_HEADER_H + players.length * ROW_H + BOTTOM_PAD;

  const renderStartedAt = Date.now();

  // Parallel pre-fetching of all player avatars.
  const avatars = await Promise.all(
    players.map((player) => {
      const summary = player.accountSummaries[0];
      // VPS has no per-render CPU cap, so prefer the full-size avatar for crisp 2× rows.
      return fetchImageBase64(summary?.avatarUrl ?? summary?.avatarUrlSmall);
    }),
  );
  const imagesFetchedAt = Date.now();

  // Column widths (card content width = 800 - 2*OUTER_PAD - 2*CARD_PAD = 684).
  const RANK_W = 46;
  const LEVEL_W = 80;
  const TROPHY_W = 224;
  const PLAYER_W = 684 - RANK_W - LEVEL_W - TROPHY_W;

  const rankBadgeStyles: Record<number, { bg: string; border: string; color: string }> = {
    1: { bg: "#fff5dc", border: "#f0c14b", color: "#a87b12" },
    2: { bg: "#f2f4f6", border: "#c8cdd5", color: "#6b7280" },
    3: { bg: "#f7ece2", border: "#d6a679", color: "#9a5b2a" },
  };

  const leaderboardHtml = (
    <CardFrame height={calculatedHeight}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", height: `${HEADER_H}px`, justifyContent: "center" }}>
        <span style={{ fontSize: "26px", fontWeight: "800", color: INK, letterSpacing: "-0.3px", marginBottom: "5px" }}>
          Таблица лидеров
        </span>
        <span style={{ fontSize: "12px", fontWeight: "700", letterSpacing: "2px", color: LABEL }}>
          БУДКА · ТОП ИГРОКОВ
        </span>
      </div>

      {/* Column header labels */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          width: "100%",
          height: `${COL_HEADER_H}px`,
          borderBottom: "1px solid #eef1f5",
          fontSize: "11px",
          color: LABEL_DIM,
          fontWeight: "800",
          letterSpacing: "1px",
          boxSizing: "border-box",
        }}
      >
        <span style={{ width: `${RANK_W}px`, display: "flex" }}>#</span>
        <span style={{ width: `${PLAYER_W}px`, display: "flex" }}>ИГРОК</span>
        <span style={{ width: `${LEVEL_W}px`, display: "flex", justifyContent: "center" }}>УР.</span>
        <span style={{ width: `${TROPHY_W}px`, display: "flex", justifyContent: "flex-end" }}>ТРОФЕИ</span>
      </div>

      {/* Player rows */}
      <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
        {players.map((player, index) => {
          const rank = index + 1;
          const avatar = avatars[index];
          const badge = rankBadgeStyles[rank];
          const handle = player.accountSummaries[0]?.onlineId || player.user.username || "";

          return (
            <div
              key={player.user.userId}
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                height: `${ROW_H}px`,
                borderBottom: "1px solid #f1f4f7",
                boxSizing: "border-box",
              }}
            >
              {/* Rank */}
              <div style={{ width: `${RANK_W}px`, display: "flex", alignItems: "center" }}>
                {badge ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "30px",
                      height: "30px",
                      borderRadius: "50%",
                      backgroundColor: badge.bg,
                      border: `1.5px solid ${badge.border}`,
                      color: badge.color,
                      fontSize: "14px",
                      fontWeight: "800",
                    }}
                  >
                    {rank}
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "30px", height: "30px" }}>
                    <span style={{ fontSize: "15px", fontWeight: "800", color: RANK_REST }}>{rank}</span>
                  </div>
                )}
              </div>

              {/* Player */}
              <div style={{ width: `${PLAYER_W}px`, display: "flex", alignItems: "center" }}>
                <div
                  style={{
                    display: "flex",
                    width: "40px",
                    height: "40px",
                    borderRadius: "50%",
                    overflow: "hidden",
                    marginRight: "12px",
                  }}
                >
                  {avatar ? (
                    <img src={avatar} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <AvatarPlaceholder label={player.user.displayName} fontSize={16} />
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", width: `${PLAYER_W - 52}px` }}>
                  <span
                    style={{
                      fontSize: "15px",
                      fontWeight: "800",
                      color: INK,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {player.user.displayName}
                  </span>
                  {handle && (
                    <span
                      style={{
                        fontSize: "12px",
                        color: LABEL,
                        fontWeight: "600",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      @{handle}
                    </span>
                  )}
                </div>
              </div>

              {/* Level */}
              <div style={{ width: `${LEVEL_W}px`, display: "flex", justifyContent: "center", alignItems: "center" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    backgroundColor: CHIP_BG,
                    borderRadius: "8px",
                    padding: "4px 12px",
                  }}
                >
                  <span style={{ fontSize: "14px", fontWeight: "800", color: BLUE }}>
                    {player.level}
                  </span>
                </div>
              </div>

              {/* Trophies */}
              <div style={{ width: `${TROPHY_W}px`, display: "flex", justifyContent: "flex-end", alignItems: "center" }}>
                {(["platinum", "gold", "silver", "bronze"] as const).map((type, tIndex) => (
                  <div
                    key={type}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      marginLeft: tIndex > 0 ? "13px" : "0",
                    }}
                  >
                    <TrophyIcon type={type} size={20} />
                    <span style={{ fontSize: "13px", fontWeight: "700", color: INK_SOFT, marginLeft: "4px" }}>
                      {player.trophies[type]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </CardFrame>
  );

  const svg = await satori(leaderboardHtml, {
    width: CARD_LOGICAL_WIDTH,
    height: calculatedHeight,
    fonts: getFontConfig(),
  });
  const satoriDoneAt = Date.now();

  const outputWidth = computeOutputWidth(CARD_LOGICAL_WIDTH, calculatedHeight, GROWABLE_RENDER_SCALE, scaleMultiplier);
  const png = rasterize(svg, outputWidth);
  console.log(
    `[leaderboard-render] players=${players.length} scale=${scaleMultiplier} outW=${outputWidth} images=${imagesFetchedAt - renderStartedAt}ms satori=${satoriDoneAt - imagesFetchedAt}ms resvg=${Date.now() - satoriDoneAt}ms`,
  );
  return png;
}

export async function renderPopularGames(games: PopularGameCardItem[], scaleMultiplier = 1): Promise<Uint8Array> {
  await initRenderer();

  const topGames = games.slice(0, 5);
  const maxPlayers = Math.max(1, ...topGames.map((game) => game.players.length));

  const HEADER_H = 64;
  const ROW_MB = 12;
  const BASE_ROW_H = 74;
  const PILL_LINE_H = 20;
  const BOTTOM_PAD = 4;
  const PLAYER_COL_W = 380;

  const pillLinesByGame = topGames.map((game) => estimatePillLines(game.players, PLAYER_COL_W));
  const rowHeights = pillLinesByGame.map((lines) => BASE_ROW_H + Math.max(0, lines - 1) * PILL_LINE_H);
  const calculatedHeight =
    OUTER_PAD * 2 +
    CARD_PAD * 2 +
    HEADER_H +
    rowHeights.reduce((sum, h) => sum + h + ROW_MB, 0) +
    BOTTOM_PAD;

  const renderStartedAt = Date.now();
  const covers = await Promise.all(topGames.map((game) => fetchImageBase64(game.imageUrl)));
  const imagesFetchedAt = Date.now();

  const popularHtml = (
    <CardFrame height={calculatedHeight}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", height: `${HEADER_H}px`, justifyContent: "center" }}>
        <span style={{ fontSize: "26px", fontWeight: "800", color: INK, letterSpacing: "-0.3px", marginBottom: "5px" }}>
          Популярные игры
        </span>
        <span style={{ fontSize: "12px", fontWeight: "700", letterSpacing: "2px", color: LABEL }}>
          БУДКА · ВО ЧТО ИГРАЮТ
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
        {topGames.map((game, index) => {
          const rank = index + 1;
          const cover = covers[index];
          const players = game.players;
          const popularity = Math.max(8, Math.round((game.players.length / maxPlayers) * 100));
          const rowHeight = rowHeights[index];

          return (
            <div
              key={`${game.name}-${rank}`}
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                height: `${rowHeight}px`,
                padding: "0 14px",
                backgroundColor: PANEL_BG,
                border: `1px solid ${PANEL_BORDER}`,
                borderRadius: "14px",
                marginBottom: `${ROW_MB}px`,
                boxSizing: "border-box",
              }}
            >
              <span style={{ fontSize: "24px", fontWeight: "800", color: "#c2cad4", width: "26px", fontFamily: FONT_MONO, marginRight: "16px" }}>
                {rank}
              </span>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "50px",
                  height: "50px",
                  borderRadius: "11px",
                  backgroundColor: COVER_BG,
                  overflow: "hidden",
                  marginRight: "16px",
                }}
              >
                {cover ? (
                  <img src={cover} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <span style={{ fontSize: "11px", fontWeight: "700", color: COVER_TEXT, fontFamily: FONT_MONO }}>
                    {gameAbbr(game.name)}
                  </span>
                )}
              </div>

              <div style={{ display: "flex", flexDirection: "column", width: `${PLAYER_COL_W}px`, marginRight: "16px" }}>
                <span
                  style={{
                    fontSize: "18px",
                    fontWeight: "800",
                    color: INK,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    marginBottom: "7px",
                  }}
                >
                  {game.name}
                </span>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", width: "100%" }}>
                  {players.map((playerName) => (
                    <div
                      key={`${game.name}-${playerName}`}
                      style={{
                        display: "flex",
                        padding: "3px 9px",
                        borderRadius: "8px",
                        backgroundColor: CHIP_BG,
                        color: PILL_TEXT,
                        fontSize: "11px",
                        fontWeight: "700",
                        marginRight: "5px",
                        marginBottom: "4px",
                      }}
                    >
                      <span style={{ whiteSpace: "nowrap" }}>{playerName}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, alignItems: "flex-end" }}>
                <span style={{ fontSize: "20px", fontWeight: "800", color: BLUE, marginBottom: "7px" }}>
                  {game.players.length}
                </span>
                <div
                  style={{
                    display: "flex",
                    width: "120px",
                    height: "7px",
                    backgroundColor: TRACK,
                    borderRadius: "4px",
                    overflow: "hidden",
                    marginBottom: "7px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      width: `${popularity}%`,
                      height: "100%",
                      backgroundImage: BLUE_GRAD_RIGHT,
                    }}
                  />
                </div>
                <span style={{ fontSize: "11px", color: LABEL, fontWeight: "600" }}>
                  {pluralizeRu(game.players.length, ["участник", "участника", "участников"])}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </CardFrame>
  );

  const svg = await satori(popularHtml, {
    width: CARD_LOGICAL_WIDTH,
    height: calculatedHeight,
    fonts: getFontConfig(),
  });
  const satoriDoneAt = Date.now();

  const outputWidth = computeOutputWidth(CARD_LOGICAL_WIDTH, calculatedHeight, GROWABLE_RENDER_SCALE, scaleMultiplier);
  const png = rasterize(svg, outputWidth);
  console.log(
    `[popular-render] games=${topGames.length} scale=${scaleMultiplier} outW=${outputWidth} images=${imagesFetchedAt - renderStartedAt}ms satori=${satoriDoneAt - imagesFetchedAt}ms resvg=${Date.now() - satoriDoneAt}ms`,
  );
  return png;
}
