import { describe, expect, test } from "bun:test";

import { getTailByWords } from "../src/llm/prompts.js";

describe("hybrid chapter context", () => {
  test("keeps only the recent tail window", () => {
    const text = "one two three four five six seven eight";
    expect(getTailByWords(text, 3)).toBe("six seven eight");
  });
});
