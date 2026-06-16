// Renderer assets (fonts, resvg.wasm, trophy/PS+ icons) are loaded lazily on
// first use and cached in module scope, so a warm process reuses the buffers
// without further round-trips.
//
// Two sources, picked per call:
//   • RENDERER_ASSETS_DIR set → read the file straight off local disk. Used when
//     self-hosting (Hetzner VPS): the files are shipped next to the code, so no
//     Supabase Storage / service_role key is involved.
//   • otherwise → fetch from the private Supabase Storage bucket with the
//     auto-injected service_role key (the Edge Functions deployment).

const BUCKET_NAME = "renderer-assets";

function getLocalAssetDir(): string | null {
  const dir = Deno.env.get("RENDERER_ASSETS_DIR");
  return dir && dir.trim() !== "" ? dir.replace(/\/$/, "") : null;
}

async function readLocalAssetBuffer(dir: string, fileName: string): Promise<ArrayBuffer> {
  try {
    const bytes = await Deno.readFile(`${dir}/${fileName}`);
    // Detach a standalone ArrayBuffer from the Uint8Array view.
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read renderer asset ${fileName} from ${dir}: ${message}`);
  }
}

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
  const localDir = getLocalAssetDir();
  if (localDir) {
    return await readLocalAssetBuffer(localDir, fileName);
  }

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
