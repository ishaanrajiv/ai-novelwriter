import { appendFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "./fs.js";

export interface EventLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  details?: Record<string, unknown>;
}

export async function appendEvent(projectDir: string, entry: EventLogEntry): Promise<void> {
  const logPath = path.join(projectDir, "logs", "events.jsonl");
  await ensureDir(path.dirname(logPath));
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
}
