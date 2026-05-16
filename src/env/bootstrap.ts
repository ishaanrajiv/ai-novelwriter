import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import type { ProviderConfig } from "../types/index.js";

interface RequiredEnvVar {
  name: string;
  prompt: string;
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }

  const inlineCommentIndex = trimmed.search(/\s+#/);
  if (inlineCommentIndex >= 0) {
    return trimmed.slice(0, inlineCommentIndex).trim();
  }

  return trimmed;
}

function parseEnvAssignment(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) return null;

  const [, key, rawValue] = match;
  if (!key || rawValue === undefined) return null;
  return { key, value: parseEnvValue(rawValue) };
}

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const assignment = parseEnvAssignment(line);
    if (assignment) values[assignment.key] = assignment.value;
  }
  return values;
}

function serializeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function mergeIntoEnvFile(filePath: string, updates: Record<string, string>): Promise<void> {
  const exists = await fileExists(filePath);
  const existingContent = exists ? await readFile(filePath, "utf8") : "";
  const lines = existingContent ? existingContent.split(/\r?\n/) : [];

  for (const [key, value] of Object.entries(updates)) {
    const lineValue = `${key}=${serializeEnvValue(value)}`;
    const idx = lines.findIndex((line) => line.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)));
    if (idx >= 0) lines[idx] = lineValue;
    else lines.push(lineValue);
  }

  const nextContent = `${lines.join("\n").replace(/\n*$/, "\n")}`;
  await writeFile(filePath, nextContent, "utf8");
}

export async function bootstrapEnvironment(envFilePath: string = path.resolve(process.cwd(), ".env")): Promise<void> {
  if (!(await fileExists(envFilePath))) return;
  const envFromFile = parseEnvFile(await readFile(envFilePath, "utf8"));
  for (const [key, value] of Object.entries(envFromFile)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export async function ensureProviderEnv(provider: ProviderConfig, envFilePath: string = path.resolve(process.cwd(), ".env")): Promise<void> {
  const required: RequiredEnvVar[] = [];
  if (provider.type === "openrouter") {
    required.push({ name: provider.openrouter.apiKeyEnv, prompt: `Enter ${provider.openrouter.apiKeyEnv}` });
  }

  const missing = required.filter((item) => {
    const value = process.env[item.name];
    return !value || !value.trim();
  });

  if (missing.length === 0) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(`Missing required env var(s): ${missing.map((item) => item.name).join(", ")}. Set them in your shell or .env.`);
  }

  const rl = createInterface({ input, output });
  const updates: Record<string, string> = {};
  try {
    for (const item of missing) {
      const answer = (await rl.question(`${item.prompt}: `)).trim();
      if (!answer) throw new Error(`${item.name} is required`);
      process.env[item.name] = answer;
      updates[item.name] = answer;
    }
  } finally {
    rl.close();
  }

  await mergeIntoEnvFile(envFilePath, updates);
}
