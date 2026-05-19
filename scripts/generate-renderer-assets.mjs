import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const functionDir = path.join(repoRoot, "supabase", "functions", "telegram-webhook");
const assetDir = path.join(repoRoot, "renderer-assets-source");
const outputPath = path.join(functionDir, "renderer-assets.ts");
const chunkSize = 4096;

const binaryAssets = [
  ["RESVG_WASM_BASE64", "resvg.wasm"],
  ["INTER_REGULAR_BASE64", "Inter-Regular.ttf"],
  ["INTER_BOLD_BASE64", "Inter-Bold.ttf"],
];
const imageAssets = [
  ["TROPHY_PLATINUM_DATA_URL", "trophy-platinum.png", "image/png"],
  ["TROPHY_GOLD_DATA_URL", "trophy-gold.png", "image/png"],
  ["TROPHY_SILVER_DATA_URL", "trophy-silver.png", "image/png"],
  ["TROPHY_BRONZE_DATA_URL", "trophy-bronze.png", "image/png"],
];

const lines = [
  "// Generated renderer assets for Supabase Edge Function bundling.",
  "// Do not edit by hand; run `npm run renderer:assets` if source assets change.",
  "",
  "function decodeBase64Chunks(chunks: readonly string[]): ArrayBuffer {",
  '  const binary = atob(chunks.join(""));',
  "  const bytes = new Uint8Array(binary.length);",
  "  for (let index = 0; index < binary.length; index += 1) {",
  "    bytes[index] = binary.charCodeAt(index);",
  "  }",
  "  return bytes.buffer;",
  "}",
  "",
];

for (const [name, fileName] of binaryAssets) {
  const filePath = path.join(assetDir, fileName);
  const base64 = fs.readFileSync(filePath).toString("base64");
  lines.push(`const ${name} = [`);

  for (let index = 0; index < base64.length; index += chunkSize) {
    lines.push(`  ${JSON.stringify(base64.slice(index, index + chunkSize))},`);
  }

  lines.push("] as const;", "");
}

for (const [name, fileName, contentType] of imageAssets) {
  const filePath = path.join(assetDir, fileName);
  const base64 = fs.readFileSync(filePath).toString("base64");
  lines.push(`const ${name} = "data:${contentType};base64,${base64}";`);
}

lines.push("");

lines.push(
  "let resvgWasmBuffer: ArrayBuffer | null = null;",
  "let interRegularBuffer: ArrayBuffer | null = null;",
  "let interBoldBuffer: ArrayBuffer | null = null;",
  "",
  "function cloneBuffer(buffer: ArrayBuffer): ArrayBuffer {",
  "  return buffer.slice(0);",
  "}",
  "",
  "export function getResvgWasmBuffer(): ArrayBuffer {",
  "  resvgWasmBuffer ??= decodeBase64Chunks(RESVG_WASM_BASE64);",
  "  return cloneBuffer(resvgWasmBuffer);",
  "}",
  "",
  "export function getInterRegularBuffer(): ArrayBuffer {",
  "  interRegularBuffer ??= decodeBase64Chunks(INTER_REGULAR_BASE64);",
  "  return cloneBuffer(interRegularBuffer);",
  "}",
  "",
  "export function getInterBoldBuffer(): ArrayBuffer {",
  "  interBoldBuffer ??= decodeBase64Chunks(INTER_BOLD_BASE64);",
  "  return cloneBuffer(interBoldBuffer);",
  "}",
  "",
  'export type TrophyKind = "platinum" | "gold" | "silver" | "bronze";',
  "",
  "const TROPHY_IMAGE_DATA_URLS: Record<TrophyKind, string> = {",
  "  platinum: TROPHY_PLATINUM_DATA_URL,",
  "  gold: TROPHY_GOLD_DATA_URL,",
  "  silver: TROPHY_SILVER_DATA_URL,",
  "  bronze: TROPHY_BRONZE_DATA_URL,",
  "};",
  "",
  "export function getTrophyImageDataUrl(type: TrophyKind): string {",
  "  return TROPHY_IMAGE_DATA_URLS[type];",
  "}",
  ""
);

fs.writeFileSync(outputPath, lines.join("\n"));
console.log(`Generated ${path.relative(repoRoot, outputPath)}`);
