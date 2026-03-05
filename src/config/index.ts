import { readFile } from "node:fs/promises";
import path from "node:path";

import YAML from "js-yaml";

import { AppConfigSchema, type AppConfig, type UserInput } from "../schemas/contracts.js";
import { ensureDir, writeTextAtomic } from "../utils/fs.js";

export async function loadConfigFromYaml(configPath: string): Promise<AppConfig> {
  const raw = await readFile(configPath, "utf-8");
  const parsed = YAML.load(raw);
  return AppConfigSchema.parse(parsed);
}

export function buildDefaultConfig(userInput: UserInput): AppConfig {
  return AppConfigSchema.parse({
    userInput,
    runtime: {},
  });
}

export async function saveConfigAsYaml(configPath: string, config: AppConfig): Promise<void> {
  await ensureDir(path.dirname(configPath));
  const yaml = YAML.dump(config, {
    lineWidth: 120,
    noRefs: true,
  });
  await writeTextAtomic(configPath, yaml);
}
