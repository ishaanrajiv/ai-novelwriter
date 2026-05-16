import { appendFile } from "node:fs/promises";

import type { RetryPolicy } from "../schemas/contracts.js";

async function debugRetryLog(event: string, details: Record<string, unknown>): Promise<void> {
  if (process.env.NOVELWRITER_DEBUG !== "1") return;
  const logPath = process.env.NOVELWRITER_DEBUG_LOG_PATH;
  if (!logPath) return;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), component: "retry", event, details })}\n`;
  try {
    await appendFile(logPath, line, "utf-8");
  } catch {
    // Best-effort debug logging.
  }
}

export async function withRetry<T>(
  policy: RetryPolicy,
  operation: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt += 1) {
    try {
      await debugRetryLog("attempt_start", { attempt, maxAttempts: policy.maxRetries + 1 });
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      await debugRetryLog("attempt_error", {
        attempt,
        maxAttempts: policy.maxRetries + 1,
        message: error instanceof Error ? error.message : String(error),
      });
      if (attempt > policy.maxRetries) {
        break;
      }
      const delayMs = backoffDelay(policy, attempt);
      await debugRetryLog("attempt_backoff", { attempt, delayMs });
      await wait(delayMs);
    }
  }

  throw lastError;
}

function backoffDelay(policy: RetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * Math.pow(2, attempt - 1);
  const clamped = Math.min(exponential, policy.maxDelayMs);
  const jitter = policy.jitterRatio > 0 ? Math.random() * clamped * policy.jitterRatio : 0;
  return Math.round(clamped + jitter);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
