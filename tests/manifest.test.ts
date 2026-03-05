import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildInitialManifest,
  checkpointIdForOutline,
  createOutlineAttemptFile,
  setCheckpoint,
} from "../src/state/manifest.js";

describe("manifest", () => {
  test("supports checkpoint transitions", async () => {
    const manifest = buildInitialManifest({
      projectId: "test-project",
      userInput: {
        bookTitle: "Book",
        author: "Author",
        language: "en",
        premise: "Premise",
        chapterCount: 2,
        targetWordCount: 10000,
        systemPromptTemplate: {
          tone: "Warm",
          pov: "Third",
          tense: "Past",
          style: "Lyrical",
          constraints: "Consistency",
          custom: "",
        },
        modelConfig: { defaultModel: "openai/gpt-4.1-mini" },
        blockPolicy: { minBlocksPerChapter: 2, maxBlocksPerChapter: 4 },
        retryPolicy: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 5000, jitterRatio: 0.1 },
      },
      runtime: {
        artifactsRoot: ".artifacts/novels",
        tailWindowWords: 1200,
      },
    });

    setCheckpoint(manifest, checkpointIdForOutline(), "in_progress", 0);
    expect(manifest.checkpoints[checkpointIdForOutline()]?.status).toBe("in_progress");

    const temp = await mkdtemp(path.join(os.tmpdir(), "manifest-attempt-"));
    const stored = await createOutlineAttemptFile(temp, { hello: "world" });
    setCheckpoint(manifest, checkpointIdForOutline(), "complete", stored.attempt);
    expect(manifest.checkpoints[checkpointIdForOutline()]?.attempt).toBe(1);

    const stored2 = await createOutlineAttemptFile(temp, { hello: "again" });
    expect(stored2.attempt).toBe(2);
  });
});
