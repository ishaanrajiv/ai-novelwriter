import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { buildInitialManifest, checkpointIdForStage, createStageAttemptFile, setCheckpoint } from "../src/state/manifest.js";

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
        provider: {
          type: "lmstudio",
          lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "LMSTUDIO_API_KEY" },
          openrouter: {
            apiKeyEnv: "OPENROUTER_API_KEY",
            httpRefererEnv: "OPENROUTER_HTTP_REFERER",
            appNameEnv: "OPENROUTER_APP_NAME",
            sessionIdEnv: "OPENROUTER_SESSION_ID",
          },
        },
        systemPromptTemplate: { tone: "Warm", pov: "Third", tense: "Past", style: "Lyrical", constraints: "Consistency", custom: "" },
        modelConfig: { defaultModel: "google/gemma-4-e4b" },
        iterationPolicy: { minPassesPerStage: 1, maxPassesPerStage: 3, convergenceWindow: 2, deltaThreshold: 0.02, stagnationPassStart: 2, stagnationChangeThreshold: 0.015, manualApprovalMode: false, qualityFloor: 0.8 },
        blockPolicy: { minBlocksPerChapter: 2, maxBlocksPerChapter: 4 },
        retryPolicy: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 5000, jitterRatio: 0.1 },
      },
      runtime: { artifactsRoot: ".artifacts/novels", tailWindowWords: 1200 },
    });

    const stageCheckpoint = checkpointIdForStage("premise_expansion");
    setCheckpoint(manifest, stageCheckpoint, "in_progress", 0);
    expect(manifest.checkpoints[stageCheckpoint]?.status).toBe("in_progress");

    const temp = await mkdtemp(path.join(os.tmpdir(), "manifest-attempt-"));
    const stored = await createStageAttemptFile(temp, { hello: "world" });
    setCheckpoint(manifest, stageCheckpoint, "complete", stored.attempt);
    expect(manifest.checkpoints[stageCheckpoint]?.attempt).toBe(1);
  });
});
