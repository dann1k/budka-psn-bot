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
let interRegularPromise: Promise<ArrayBuffer> | null = null;
let interBoldPromise: Promise<ArrayBuffer> | null = null;

export async function getResvgWasmBuffer(): Promise<ArrayBuffer> {
  resvgWasmPromise ??= fetchAssetBuffer("resvg.wasm");
  return cloneBuffer(await resvgWasmPromise);
}

export async function getInterRegularBuffer(): Promise<ArrayBuffer> {
  interRegularPromise ??= fetchAssetBuffer("Inter-Regular.ttf");
  return cloneBuffer(await interRegularPromise);
}

export async function getInterBoldBuffer(): Promise<ArrayBuffer> {
  interBoldPromise ??= fetchAssetBuffer("Inter-Bold.ttf");
  return cloneBuffer(await interBoldPromise);
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
