import { describe, expect, test } from "bun:test";

import { withRetry } from "../src/utils/retry.js";

describe("retry", () => {
  test("retries until success", async () => {
    let attempts = 0;

    const result = await withRetry(
      {
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        jitterRatio: 0,
      },
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("temporary");
        }
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });
});
