import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { createAndRunProject, exportProjectEpub, regenerateProject, resumeProject } from "../src/pipeline/service.js";
import type { LLMClient } from "../src/llm/provider.js";
import type { AppConfig, OutlineResult } from "../src/schemas/contracts.js";

class MockLLMClient implements LLMClient {
  async generateJson<T>(options: { stage: string; model: string; system: string; prompt: string; schema: z.ZodType<T> }): Promise<{ object: T }> {
    if (options.stage === "chapter_outline") {
      const result: OutlineResult = {
        bookTitle: "Auto Generated Smoke Title",
        globalStoryArc: "Hero transforms while confronting a hidden conspiracy.",
        chapters: [
          { chapterNumber: 1, title: "Chapter 1 Title", summary: "Summary for chapter 1", targetWordsGuideline: 1800 },
          { chapterNumber: 2, title: "Chapter 2 Title", summary: "Summary for chapter 2", targetWordsGuideline: 1800 },
        ],
      };
      return { object: options.schema.parse(result) };
    }

    if (options.stage.includes(":critic:")) {
      return { object: options.schema.parse({ score: 0.9, notes: "Looks solid" }) };
    }

    throw new Error(`Unexpected JSON stage: ${options.stage}`);
  }

  async generateText(options: { stage: string }): Promise<{ text: string }> {
    if (options.stage.includes("premise_expansion") || options.stage.includes("story_summary")) {
      return { text: `Generated ${options.stage}` };
    }
    if (options.stage.startsWith("planner:")) {
      return { text: "Advance to next stage." };
    }
    if (options.stage.includes("chapter_loop")) {
      return { text: "Chapter prose content." };
    }
    if (options.stage.includes("global_revision")) {
      return { text: "Revised full manuscript." };
    }
    return { text: "generic" };
  }
}

function makeConfig(artifactsRoot: string): AppConfig {
  return {
    userInput: {
      bookTitle: "Smoke Novel",
      author: "Test Author",
      language: "en",
      premise: "A town discovers reality is being rewritten.",
      chapterCount: 2,
      targetWordCount: 12000,
      provider: {
        type: "lmstudio",
        lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "LMSTUDIO_API_KEY" },
        openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", httpRefererEnv: "OPENROUTER_HTTP_REFERER", appNameEnv: "OPENROUTER_APP_NAME" },
      },
      systemPromptTemplate: { tone: "Moody", pov: "Third-person limited", tense: "Past", style: "Cinematic", constraints: "Keep continuity", custom: "" },
      modelConfig: { defaultModel: "google/gemma-4-e4b" },
      iterationPolicy: { minPassesPerStage: 1, convergenceWindow: 1, deltaThreshold: 0.02, manualApprovalMode: false, qualityFloor: 0.8 },
      blockPolicy: { minBlocksPerChapter: 2, maxBlocksPerChapter: 4 },
      retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    },
    runtime: { artifactsRoot, tailWindowWords: 300 },
  };
}

describe("pipeline smoke", () => {
  test("end-to-end run creates artifacts and epub", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novel-smoke-"));
    const config = makeConfig(root);
    const result = await createAndRunProject({ config, deps: { llmClient: new MockLLMClient() } });

    await access(path.join(result.projectDir, "stage0-premise", "active.md"));
    await access(path.join(result.projectDir, "stage1-summary", "active.md"));
    await access(path.join(result.projectDir, "stage2-outline", "active.json"));
    await access(path.join(result.projectDir, "stage3-chapters", "ch-001", "chapter.active.md"));

    const epub = await exportProjectEpub({ artifactsRoot: root, projectId: result.projectId });
    await access(epub);
  });

  test("auto-generates title during outline and persists it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novel-auto-title-"));
    const config = makeConfig(root);
    config.userInput.bookTitle = "";

    const result = await createAndRunProject({ config, deps: { llmClient: new MockLLMClient() } });
    const manifest = JSON.parse(await readFile(path.join(result.projectDir, "manifest.json"), "utf-8")) as { bookTitle?: string };
    expect(result.projectId.endsWith("_auto-generated-smoke-title")).toBe(true);
    expect(manifest.bookTitle).toBe("Auto Generated Smoke Title");
  });

  test("resume and regen complete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novel-resume-"));
    const config = makeConfig(root);
    const result = await createAndRunProject({ config, deps: { llmClient: new MockLLMClient() } });

    const resumed = await resumeProject({ artifactsRoot: root, projectId: result.projectId, deps: { llmClient: new MockLLMClient() } });
    expect(resumed).toBe(result.projectId);

    await regenerateProject({ artifactsRoot: root, projectId: result.projectId, target: "chapter", chapter: 1, deps: { llmClient: new MockLLMClient() } });
    await access(path.join(result.projectDir, "stage3-chapters", "ch-001", "chapter.active.md"));
  });
});
