#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..");
const distEntrypoint = resolve(rootDir, "dist/index.js");
const srcEntrypoint = resolve(rootDir, "src/index.ts");
const args = process.argv.slice(2);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (existsSync(distEntrypoint)) {
  run(process.execPath, [distEntrypoint, ...args]);
}

run("bun", ["run", srcEntrypoint, ...args]);
