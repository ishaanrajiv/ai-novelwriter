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

export interface FailureLogEntry {
  ts: string;
  error: string;
  stepId?: string;
  checkpointId?: string;
  details?: Record<string, unknown>;
}

export async function appendFailure(projectDir: string, entry: FailureLogEntry): Promise<void> {
  const logPath = path.join(projectDir, "log", "failures.jsonl");
  await ensureDir(path.dirname(logPath));
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
}
