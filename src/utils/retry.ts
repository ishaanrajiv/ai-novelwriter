import type { RetryPolicy } from "../schemas/contracts.js";

export async function withRetry<T>(
  policy: RetryPolicy,
  operation: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt > policy.maxRetries) {
        break;
      }
      const delayMs = backoffDelay(policy, attempt);
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
