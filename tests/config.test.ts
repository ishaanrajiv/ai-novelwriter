import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { loadConfigFromYaml } from "../src/config/index.js";

describe("config", () => {
  test("loads and validates yaml config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "novel-config-"));
    const file = path.join(dir, "config.yaml");
    await writeFile(
      file,
      `userInput:\n  bookTitle: Test Book\n  author: Tester\n  language: en\n  premise: A mystery unfolds\n  chapterCount: 4\n  targetWordCount: 20000\n  systemPromptTemplate:\n    tone: Dark\n    pov: First person\n    tense: Past\n    style: Sparse\n    constraints: Keep continuity\n    custom: ''\n  modelConfig:\n    defaultModel: openai/gpt-4.1-mini\n  blockPolicy:\n    minBlocksPerChapter: 2\n    maxBlocksPerChapter: 4\n  retryPolicy:\n    maxRetries: 2\n    baseDelayMs: 200\n    maxDelayMs: 1000\n    jitterRatio: 0.1\nruntime:\n  artifactsRoot: .artifacts/novels\n  tailWindowWords: 900\n`,
      "utf-8",
    );

    const config = await loadConfigFromYaml(file);
    expect(config.userInput.bookTitle).toBe("Test Book");
    expect(config.runtime.tailWindowWords).toBe(900);
  });
});
