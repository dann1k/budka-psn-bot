import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const checkArgs = ["check", "supabase/functions/telegram-webhook/index.ts"];

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandWorks(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore"
  });

  return result.status === 0;
}

function findCachedNpxDeno() {
  const npxRoot = path.join(os.homedir(), ".npm", "_npx");

  if (!fs.existsSync(npxRoot)) {
    return null;
  }

  const candidates = [];
  for (const entry of fs.readdirSync(npxRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidate = path.join(npxRoot, entry.name, "node_modules", ".bin", "deno");
    if (isExecutable(candidate)) {
      candidates.push(candidate);
    }
  }

  return candidates
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
    .at(0) ?? null;
}

function findDeno() {
  const explicitDeno = process.env.DENO_BIN;
  if (explicitDeno && isExecutable(explicitDeno)) {
    return explicitDeno;
  }

  if (commandWorks("deno")) {
    return "deno";
  }

  const commonPaths = [
    path.join(os.homedir(), ".deno", "bin", "deno"),
    "/opt/homebrew/bin/deno",
    "/usr/local/bin/deno"
  ];

  for (const candidate of commonPaths) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return findCachedNpxDeno();
}

const deno = findDeno();

if (!deno) {
  console.error("Deno binary was not found.");
  console.error("Install Deno or set DENO_BIN to an executable deno path.");
  console.error("macOS install example: brew install deno");
  process.exit(1);
}

const result = spawnSync(deno, checkArgs, {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
