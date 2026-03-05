import { access, mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  createAndRunProject,
  exportProjectEpub,
  regenerateProject,
  resumeProject,
} from "../src/pipeline/service.js";
import type { LLMClient } from "../src/llm/provider.js";
import type { AppConfig, ChapterBlockDraft, OutlineResult, StoryBlocksResult } from "../src/schemas/contracts.js";

class MockLLMClient implements LLMClient {
  private readonly chapterCount: number;
  private readonly failStageOnce: string | null;
  private failures = new Set<string>();

  constructor(chapterCount: number, failStageOnce?: string) {
    this.chapterCount = chapterCount;
    this.failStageOnce = failStageOnce ?? null;
  }

  async generateJson<T>(options: {
    stage: string;
    model: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
  }): Promise<{ object: T }> {
    if (this.failStageOnce && options.stage === this.failStageOnce && !this.failures.has(options.stage)) {
      this.failures.add(options.stage);
      throw new Error(`Injected failure for ${options.stage}`);
    }

    if (options.stage === "outline") {
      const result: OutlineResult = {
        bookTitle: "Auto Generated Smoke Title",
        globalStoryArc: "Hero transforms while confronting a hidden conspiracy.",
        chapters: Array.from({ length: this.chapterCount }, (_, index) => ({
          chapterNumber: index + 1,
          title: `Chapter ${index + 1} Title`,
          summary: `Summary for chapter ${index + 1}`,
          targetWordsGuideline: 1800,
        })),
      };
      return { object: options.schema.parse(result) };
    }

    if (options.stage.startsWith("blocks:")) {
      const chapterNumber = Number.parseInt(options.stage.split(":")[1] ?? "1", 10);
      const result: StoryBlocksResult = {
        chapterNumber,
        chapterTitle: `Chapter ${chapterNumber} Title`,
        blocks: [
          {
            blockNumber: 1,
            goal: "Set up conflict",
            events: ["Inciting incident"],
            characters: ["Protagonist"],
            continuityNotes: ["Maintain suspense"],
            targetWordsGuideline: 900,
          },
          {
            blockNumber: 2,
            goal: "Escalate conflict",
            events: ["Complication"],
            characters: ["Protagonist", "Antagonist"],
            continuityNotes: ["Carry unresolved tension"],
            targetWordsGuideline: 900,
          },
        ],
      };
      return { object: options.schema.parse(result) };
    }

    if (options.stage.startsWith("chapter:")) {
      const blockNumber = Number.parseInt(options.stage.split(":")[3] ?? "1", 10);
      const draft: ChapterBlockDraft = {
        blockNumber,
        text: `Generated prose for block ${blockNumber}.`,
        updatedSummary: {
          plotState: `Plot advanced at block ${blockNumber}`,
          characterState: `Characters evolved at block ${blockNumber}`,
          openLoops: ["Who can be trusted?"],
          styleConstraints: ["Keep voice consistent"],
        },
      };
      return { object: options.schema.parse(draft) };
    }

    throw new Error(`Unexpected stage: ${options.stage}`);
  }

  async generateText(): Promise<{ text: string }> {
    return { text: "unused" };
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
      systemPromptTemplate: {
        tone: "Moody",
        pov: "Third-person limited",
        tense: "Past",
        style: "Cinematic",
        constraints: "Keep continuity",
        custom: "",
      },
      modelConfig: {
        defaultModel: "openai/gpt-4.1-mini",
      },
      blockPolicy: {
        minBlocksPerChapter: 2,
        maxBlocksPerChapter: 4,
      },
      retryPolicy: {
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitterRatio: 0,
      },
    },
    runtime: {
      artifactsRoot,
      tailWindowWords: 300,
    },
  };
}

function makeAutoTitleConfig(artifactsRoot: string): AppConfig {
  const base = makeConfig(artifactsRoot);
  return {
    ...base,
    userInput: {
      ...base.userInput,
      bookTitle: "",
    },
  };
}

describe("pipeline smoke", () => {
  test("end-to-end run creates artifacts and epub", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novel-smoke-"));
    const config = makeConfig(root);
    const mock = new MockLLMClient(config.userInput.chapterCount);

    const result = await createAndRunProject({ config, deps: { llmClient: mock } });

    await access(path.join(result.projectDir, "stage1-outline", "active.json"));
    await access(path.join(result.projectDir, "stage2-blocks", "ch-001.active.json"));
    await access(path.join(result.projectDir, "stage3-chapters", "ch-001", "chapter.active.md"));

    const epub = await exportProjectEpub({ artifactsRoot: root, projectId: result.projectId });
    await access(epub);
  });

  test("auto-generates title during outline and persists it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novel-auto-title-"));
    const config = makeAutoTitleConfig(root);
    const mock = new MockLLMClient(config.userInput.chapterCount);

    const result = await createAndRunProject({ config, deps: { llmClient: mock } });
    const manifestSource = await readFile(path.join(result.projectDir, "manifest.json"), "utf-8");
    const manifest = JSON.parse(manifestSource) as { bookTitle?: string };

    expect(result.projectId.endsWith("_auto-generated-smoke-title")).toBe(true);
    expect(manifest.bookTitle).toBe("Auto Generated Smoke Title");
  });

  test("resume continues after injected failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novel-resume-"));
    const config = makeConfig(root);
    const projectId = "2026-03-05_22-20-00_resume-case";

    await expect(
      createAndRunProject({
        config,
        projectId,
        deps: { llmClient: new MockLLMClient(config.userInput.chapterCount, "blocks:2") },
      }),
    ).rejects.toThrow("Injected failure");

    await resumeProject({
      artifactsRoot: root,
      projectId,
      deps: { llmClient: new MockLLMClient(config.userInput.chapterCount) },
    });

    await access(path.join(root, projectId, "stage3-chapters", "ch-002", "chapter.active.md"));
  });

  test("resume without project-id picks latest incomplete project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novel-resume-auto-"));
    const config = makeConfig(root);
    const olderIncompleteId = "2026-03-05_22-20-00_resume-older";
    const newerIncompleteId = "2026-03-05_22-21-00_resume-newer";

    await expect(
      createAndRunProject({
        config,
        projectId: olderIncompleteId,
        deps: { llmClient: new MockLLMClient(config.userInput.chapterCount, "blocks:2") },
      }),
    ).rejects.toThrow("Injected failure");

    await expect(
      createAndRunProject({
        config,
        projectId: newerIncompleteId,
        deps: { llmClient: new MockLLMClient(config.userInput.chapterCount, "blocks:2") },
      }),
    ).rejects.toThrow("Injected failure");

    const resumedId = await resumeProject({
      artifactsRoot: root,
      deps: { llmClient: new MockLLMClient(config.userInput.chapterCount) },
    });

    expect(resumedId).toBe(newerIncompleteId);
    await access(path.join(root, newerIncompleteId, "stage3-chapters", "ch-002", "chapter.active.md"));
  });

  test("resume without project-id fails when all projects are complete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novel-resume-none-"));
    const config = makeConfig(root);

    await createAndRunProject({
      config,
      deps: { llmClient: new MockLLMClient(config.userInput.chapterCount) },
    });

    await expect(
      resumeProject({
        artifactsRoot: root,
        deps: { llmClient: new MockLLMClient(config.userInput.chapterCount) },
      }),
    ).rejects.toThrow("No incomplete projects found");
  });

  test("regen block creates a new attempt version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novel-regen-"));
    const config = makeConfig(root);
    const mock = new MockLLMClient(config.userInput.chapterCount);

    const result = await createAndRunProject({ config, deps: { llmClient: mock } });

    await regenerateProject({
      artifactsRoot: root,
      projectId: result.projectId,
      target: "block",
      chapter: 1,
      block: 1,
      deps: { llmClient: new MockLLMClient(config.userInput.chapterCount) },
    });

    const chDir = path.join(root, result.projectId, "stage3-chapters", "ch-001");
    const files = await readdir(chDir);
    expect(files.some((name) => name === "block-001.attempt-002.json")).toBe(true);

    const chapterActive = await readFile(path.join(chDir, "chapter.active.md"), "utf-8");
    expect(chapterActive).toContain("Chapter 1");
  });
});
