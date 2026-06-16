// Renderer assets live in a private Supabase Storage bucket and are fetched
// lazily on cold start using the auto-injected service_role key, which
// bypasses RLS. The first call populates module-scoped caches so subsequent
// invocations of the warm isolate reuse the buffers without further network
// round-trips.

const BUCKET_NAME = "renderer-assets";

function readEnv(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Environment variable ${name} is required to load renderer assets`);
  }

  return value;
}

function getBucketBaseUrl(): string {
  return `${readEnv("SUPABASE_URL").replace(/\/$/, "")}/storage/v1/object/${BUCKET_NAME}`;
}

async function fetchAssetBuffer(fileName: string): Promise<ArrayBuffer> {
  const url = `${getBucketBaseUrl()}/${fileName}`;
  const serviceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch renderer asset ${fileName} (${response.status} ${response.statusText})`,
    );
  }

  return await response.arrayBuffer();
}

async function fetchAssetDataUrl(fileName: string, contentType: string): Promise<string> {
  const buffer = await fetchAssetBuffer(fileName);
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return `data:${contentType};base64,${btoa(binary)}`;
}

function cloneBuffer(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}

let resvgWasmPromise: Promise<ArrayBuffer> | null = null;
let manropeRegularPromise: Promise<ArrayBuffer> | null = null;
let manropeBoldPromise: Promise<ArrayBuffer> | null = null;
let manropeExtraBoldPromise: Promise<ArrayBuffer> | null = null;
let spaceMonoBoldPromise: Promise<ArrayBuffer> | null = null;

export async function getResvgWasmBuffer(): Promise<ArrayBuffer> {
  resvgWasmPromise ??= fetchAssetBuffer("resvg.wasm");
  return cloneBuffer(await resvgWasmPromise);
}

// Manrope + Space Mono power the "PS5 Минимал" light card design. Manrope is the
// body/heading face (weights 400/700/800, all with Cyrillic glyphs); Space Mono
// is the monospace label/eyebrow face (Latin-only — Cyrillic in those labels
// falls back to Manrope automatically via Satori's per-glyph font fallback).
export async function getManropeRegularBuffer(): Promise<ArrayBuffer> {
  manropeRegularPromise ??= fetchAssetBuffer("Manrope-Regular.ttf");
  return cloneBuffer(await manropeRegularPromise);
}

export async function getManropeBoldBuffer(): Promise<ArrayBuffer> {
  manropeBoldPromise ??= fetchAssetBuffer("Manrope-Bold.ttf");
  return cloneBuffer(await manropeBoldPromise);
}

export async function getManropeExtraBoldBuffer(): Promise<ArrayBuffer> {
  manropeExtraBoldPromise ??= fetchAssetBuffer("Manrope-ExtraBold.ttf");
  return cloneBuffer(await manropeExtraBoldPromise);
}

export async function getSpaceMonoBoldBuffer(): Promise<ArrayBuffer> {
  spaceMonoBoldPromise ??= fetchAssetBuffer("SpaceMono-Bold.ttf");
  return cloneBuffer(await spaceMonoBoldPromise);
}

export type TrophyKind = "platinum" | "gold" | "silver" | "bronze";

const TROPHY_FILE_NAMES: Record<TrophyKind, string> = {
  platinum: "trophy-platinum.png",
  gold: "trophy-gold.png",
  silver: "trophy-silver.png",
  bronze: "trophy-bronze.png",
};

const trophyDataUrls: Partial<Record<TrophyKind, string>> = {};
let trophyPreloadPromise: Promise<void> | null = null;
let playStationPlusDataUrl: string | null = null;
let playStationPlusPreloadPromise: Promise<void> | null = null;

export function preloadTrophyImages(): Promise<void> {
  trophyPreloadPromise ??= (async () => {
    const kinds = Object.keys(TROPHY_FILE_NAMES) as TrophyKind[];
    const dataUrls = await Promise.all(
      kinds.map((kind) => fetchAssetDataUrl(TROPHY_FILE_NAMES[kind], "image/png")),
    );

    for (let index = 0; index < kinds.length; index += 1) {
      trophyDataUrls[kinds[index]] = dataUrls[index];
    }
  })();

  return trophyPreloadPromise;
}

export function getTrophyImageDataUrl(type: TrophyKind): string {
  const dataUrl = trophyDataUrls[type];

  if (!dataUrl) {
    throw new Error(`Trophy image for ${type} was not preloaded; call preloadTrophyImages() first`);
  }

  return dataUrl;
}

export function preloadPlayStationPlusImage(): Promise<void> {
  playStationPlusPreloadPromise ??= (async () => {
    playStationPlusDataUrl = await fetchAssetDataUrl("playstation-plus.png", "image/png");
  })();

  return playStationPlusPreloadPromise;
}

export function getPlayStationPlusImageDataUrl(): string {
  if (!playStationPlusDataUrl) {
    throw new Error("PlayStation Plus image was not preloaded; call preloadPlayStationPlusImage() first");
  }

  return playStationPlusDataUrl;
}
