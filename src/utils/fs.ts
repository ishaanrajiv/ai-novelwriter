import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, "utf-8");
  return JSON.parse(content) as T;
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await ensureDir(path.dirname(filePath));
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await rename(tempPath, filePath);
}

export async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await ensureDir(path.dirname(filePath));
  await writeFile(tempPath, value, "utf-8");
  await rename(tempPath, filePath);
}

export async function nextAttemptNumber(
  dirPath: string,
  prefix: string,
  format: "dot" | "dash" = "dot",
): Promise<number> {
  await ensureDir(dirPath);
  const files = await readdir(dirPath);
  const pattern =
    format === "dot"
      ? new RegExp(`^${prefix}\\.attempt-(\\d{3})\\.`)
      : new RegExp(`^${prefix}-(\\d{3})\\.`);
  const matches = files
    .map((name) => {
      const match = name.match(pattern);
      const value = match?.[1];
      return value ? Number.parseInt(value, 10) : 0;
    })
    .filter((n) => n > 0);

  if (matches.length === 0) {
    return 1;
  }

  return Math.max(...matches) + 1;
}

export async function clearFileIfExists(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
