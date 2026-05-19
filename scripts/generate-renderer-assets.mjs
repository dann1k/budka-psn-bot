import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const functionDir = path.join(repoRoot, "supabase", "functions", "telegram-webhook");
const assetDir = path.join(functionDir, "assets");
const outputPath = path.join(functionDir, "renderer-assets.ts");
const chunkSize = 4096;

const assets = [
  ["RESVG_WASM_BASE64", "resvg.wasm"],
  ["INTER_REGULAR_BASE64", "Inter-Regular.ttf"],
  ["INTER_BOLD_BASE64", "Inter-Bold.ttf"],
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

for (const [name, fileName] of assets) {
  const filePath = path.join(assetDir, fileName);
  const base64 = fs.readFileSync(filePath).toString("base64");
  lines.push(`const ${name} = [`);

  for (let index = 0; index < base64.length; index += chunkSize) {
    lines.push(`  ${JSON.stringify(base64.slice(index, index + chunkSize))},`);
  }

  lines.push("] as const;", "");
}

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
  ""
);

fs.writeFileSync(outputPath, lines.join("\n"));
console.log(`Generated ${path.relative(repoRoot, outputPath)}`);
