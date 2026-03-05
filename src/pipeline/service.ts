import { access, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import YAML from "js-yaml";
import { z } from "zod";

import { saveConfigAsYaml } from "../config/index.js";
import { createOpenRouterLLMClient, type LLMClient } from "../llm/provider.js";
import {
  buildBlocksPrompt,
  buildChapterBlockPrompt,
  buildChapterFinalizeText,
  buildOutlinePrompt,
  buildSystemPrompt,
  getTailByWords,
  initialRollingSummary,
} from "../llm/prompts.js";
import { exportStyledEpub } from "../output/epub.js";
import { buildChapterMarkdown } from "../output/markdown.js";
import {
  ChapterBlockDraftSchema,
  OutlineResultSchema,
  StoryBlocksResultSchema,
  AppConfigSchema,
  type AppConfig,
  type ChapterBlockDraft,
  type OutlineResult,
  type ProjectManifest,
  type StoryBlocksResult,
} from "../schemas/contracts.js";
import {
  buildInitialManifest,
  checkpointIdForBlock,
  checkpointIdForBlocks,
  checkpointIdForChapter,
  checkpointIdForExportEpub,
  checkpointIdForOutline,
  createBlocksAttemptFile,
  createChapterAttemptFile,
  createChapterBlockAttemptFile,
  createOutlineAttemptFile,
  getCheckpointStatus,
  getProjectPaths,
  initProjectDirs,
  loadManifest,
  saveManifest,
  setCheckpoint,
} from "../state/manifest.js";
import type { CheckpointStatus, RetryPolicy } from "../types/index.js";
import { ensureDir, readJsonFile, writeJsonAtomic } from "../utils/fs.js";
import { blockKey, chapterKey, createProjectId, formatLocalTimestamp, slugify } from "../utils/ids.js";
import { appendEvent } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";

export interface PipelineDeps {
  llmClient?: LLMClient;
  now?: () => Date;
}

export type PipelineStepId = "outline" | "blocks" | "chapter_drafts" | "export_epub";
export type PipelineStepState = "in_progress" | "complete" | "skipped" | "failed";

export interface PipelineProgressEvent {
  stepId: PipelineStepId;
  stepLabel: string;
  stepIndex: number;
  stepCount: number;
  done: number;
  total: number;
  state: PipelineStepState;
  message: string;
  checkpointId?: string;
  checkpointPath?: string;
  checkpointUrl?: string;
}

export interface PipelineProgressReporter {
  onProgress(event: PipelineProgressEvent): void;
}

interface PipelineStepMeta {
  id: PipelineStepId;
  label: string;
  index: number;
  count: number;
}

const PIPELINE_STEPS: Record<PipelineStepId, PipelineStepMeta> = {
  outline: { id: "outline", label: "Outline", index: 1, count: 4 },
  blocks: { id: "blocks", label: "Story Blocks", index: 2, count: 4 },
  chapter_drafts: { id: "chapter_drafts", label: "Chapter Drafts", index: 3, count: 4 },
  export_epub: { id: "export_epub", label: "EPUB Export", index: 4, count: 4 },
};

const MAX_CHAPTER_CONCURRENCY = 4;

function toFileUrl(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

function emitProgress(
  reporter: PipelineProgressReporter | undefined,
  step: PipelineStepMeta,
  event: Omit<PipelineProgressEvent, "stepId" | "stepLabel" | "stepIndex" | "stepCount">,
): void {
  if (!reporter) {
    return;
  }

  try {
    reporter.onProgress({
      stepId: step.id,
      stepLabel: step.label,
      stepIndex: step.index,
      stepCount: step.count,
      ...event,
    });
  } catch {
    // Rendering should never break generation.
  }
}

const BLOCK_DRAFT_SCHEMA = z.object({
  blockNumber: z.number().int().positive(),
  text: z.string().min(1),
  updatedSummary: z.object({
    plotState: z.string().min(1),
    characterState: z.string().min(1),
    openLoops: z.array(z.string().min(1)).default([]),
    styleConstraints: z.array(z.string().min(1)).default([]),
  }),
});

function resolveModel(config: AppConfig, stage: "outline" | "blocks" | "chapter" | "memory", override?: string): string {
  if (override) {
    return override;
  }
  const m = config.userInput.modelConfig;
  if (stage === "outline") {
    return m.outlineModel ?? m.defaultModel;
  }
  if (stage === "blocks") {
    return m.blocksModel ?? m.defaultModel;
  }
  if (stage === "chapter") {
    return m.chapterModel ?? m.defaultModel;
  }
  return m.memoryModel ?? m.chapterModel ?? m.defaultModel;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  let nextIndex = 0;
  let firstError: unknown;

  const runWorker = async (): Promise<void> => {
    while (true) {
      if (firstError) {
        return;
      }

      const itemIndex = nextIndex;
      if (itemIndex >= items.length) {
        return;
      }
      nextIndex += 1;

      try {
        await worker(items[itemIndex]!);
      } catch (error) {
        if (!firstError) {
          firstError = error;
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  if (firstError) {
    throw firstError;
  }
}

async function loadActiveOutline(projectDir: string, fallbackBookTitle?: string): Promise<OutlineResult> {
  const filePath = path.join(projectDir, "stage1-outline", "active.json");
  const parsed = await readJsonFile<unknown>(filePath);

  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as { bookTitle?: unknown }).bookTitle === "undefined" &&
    fallbackBookTitle?.trim()
  ) {
    return OutlineResultSchema.parse({
      ...parsed,
      bookTitle: fallbackBookTitle.trim(),
    });
  }

  return OutlineResultSchema.parse(parsed);
}

async function loadActiveChapterBlocks(projectDir: string, chapterNumber: number): Promise<StoryBlocksResult> {
  const filePath = path.join(projectDir, "stage2-blocks", `${chapterKey(chapterNumber)}.active.json`);
  const parsed = await readJsonFile<unknown>(filePath);
  return StoryBlocksResultSchema.parse(parsed);
}

async function loadActiveBlockDraft(
  projectDir: string,
  chapterNumber: number,
  blockNumber: number,
): Promise<ChapterBlockDraft | null> {
  const filePath = path.join(
    projectDir,
    "stage3-chapters",
    chapterKey(chapterNumber),
    `${blockKey(blockNumber)}.active.json`,
  );

  try {
    const parsed = await readJsonFile<unknown>(filePath);
    return ChapterBlockDraftSchema.parse(parsed);
  } catch {
    return null;
  }
}

async function runStageOutline(args: {
  config: AppConfig;
  paths: ReturnType<typeof getProjectPaths>;
  manifest: ProjectManifest;
  llmClient: LLMClient;
  progressReporter?: PipelineProgressReporter;
  modelOverride?: string;
  force?: boolean;
}): Promise<OutlineResult> {
  const checkpointId = checkpointIdForOutline();
  const currentStatus = getCheckpointStatus(args.manifest, checkpointId);
  if (!args.force && currentStatus === "complete") {
    const checkpointPath = path.join(args.paths.outlineDir, "active.json");
    emitProgress(args.progressReporter, PIPELINE_STEPS.outline, {
      done: 1,
      total: 1,
      state: "skipped",
      message: "Using existing outline checkpoint.",
      checkpointId,
      checkpointPath,
      checkpointUrl: toFileUrl(checkpointPath),
    });
    return loadActiveOutline(args.paths.projectDir, args.manifest.bookTitle);
  }

  emitProgress(args.progressReporter, PIPELINE_STEPS.outline, {
    done: 0,
    total: 1,
    state: "in_progress",
    message: "Generating story outline...",
    checkpointId,
  });

  setCheckpoint(args.manifest, checkpointId, "in_progress", args.manifest.activePointers.outlineAttempt);
  await saveManifest(args.paths.manifestPath, args.manifest);

  const model = resolveModel(args.config, "outline", args.modelOverride);
  const system = buildSystemPrompt(args.config.userInput.systemPromptTemplate);
  const prompt = buildOutlinePrompt(args.config.userInput);

  try {
    const result = await withRetry(args.config.userInput.retryPolicy, async () => {
      return args.llmClient.generateJson({
        stage: "outline",
        model,
        system,
        prompt,
        schema: OutlineResultSchema,
      });
    });

    const stored = await createOutlineAttemptFile(args.paths.outlineDir, result.object);
    args.manifest.activePointers.outlineAttempt = stored.attempt;
    setCheckpoint(args.manifest, checkpointId, "complete", stored.attempt);
    await saveManifest(args.paths.manifestPath, args.manifest);

    emitProgress(args.progressReporter, PIPELINE_STEPS.outline, {
      done: 1,
      total: 1,
      state: "complete",
      message: "Outline checkpoint written.",
      checkpointId,
      checkpointPath: stored.activePath,
      checkpointUrl: toFileUrl(stored.activePath),
    });

    await appendEvent(args.paths.projectDir, {
      ts: new Date().toISOString(),
      level: "info",
      event: "stage_outline_complete",
      details: { attempt: stored.attempt, model },
    });

    return result.object;
  } catch (error) {
    setCheckpoint(args.manifest, checkpointId, "failed", args.manifest.activePointers.outlineAttempt, toErrorMessage(error));
    await saveManifest(args.paths.manifestPath, args.manifest);
    emitProgress(args.progressReporter, PIPELINE_STEPS.outline, {
      done: 0,
      total: 1,
      state: "failed",
      message: `Outline generation failed: ${toErrorMessage(error)}`,
      checkpointId,
    });
    throw error;
  }
}

async function runStageBlocks(args: {
  config: AppConfig;
  paths: ReturnType<typeof getProjectPaths>;
  manifest: ProjectManifest;
  llmClient: LLMClient;
  outline: OutlineResult;
  progressReporter?: PipelineProgressReporter;
  modelOverride?: string;
  forceChapter?: number;
}): Promise<Map<number, StoryBlocksResult>> {
  const map = new Map<number, StoryBlocksResult>();
  const system = buildSystemPrompt(args.config.userInput.systemPromptTemplate);
  const model = resolveModel(args.config, "blocks", args.modelOverride);
  const totalChapters = args.outline.chapters.length;
  const chapterConcurrency = Math.min(MAX_CHAPTER_CONCURRENCY, Math.max(1, totalChapters));
  let completedChapters = 0;
  const markChapterDone = (): number => {
    completedChapters += 1;
    return completedChapters;
  };

  emitProgress(args.progressReporter, PIPELINE_STEPS.blocks, {
    done: 0,
    total: totalChapters,
    state: "in_progress",
    message: totalChapters > 0 ? "Planning chapter block structures..." : "No chapters to plan.",
  });

  await runWithConcurrencyLimit(args.outline.chapters, chapterConcurrency, async (chapter) => {
    const chapterId = chapter.chapterNumber;
    const checkpointId = checkpointIdForBlocks(chapterId);
    const status = getCheckpointStatus(args.manifest, checkpointId);

    if (!args.forceChapter && status === "complete") {
      map.set(chapterId, await loadActiveChapterBlocks(args.paths.projectDir, chapterId));
      const done = markChapterDone();
      const checkpointPath = path.join(args.paths.blocksDir, `${chapterKey(chapterId)}.active.json`);
      emitProgress(args.progressReporter, PIPELINE_STEPS.blocks, {
        done,
        total: totalChapters,
        state: "skipped",
        message: `Reusing block plan for chapter ${chapterId}.`,
        checkpointId,
        checkpointPath,
        checkpointUrl: toFileUrl(checkpointPath),
      });
      return;
    }

    if (args.forceChapter && args.forceChapter !== chapterId && status === "complete") {
      map.set(chapterId, await loadActiveChapterBlocks(args.paths.projectDir, chapterId));
      const done = markChapterDone();
      const checkpointPath = path.join(args.paths.blocksDir, `${chapterKey(chapterId)}.active.json`);
      emitProgress(args.progressReporter, PIPELINE_STEPS.blocks, {
        done,
        total: totalChapters,
        state: "skipped",
        message: `Reusing block plan for chapter ${chapterId}.`,
        checkpointId,
        checkpointPath,
        checkpointUrl: toFileUrl(checkpointPath),
      });
      return;
    }

    emitProgress(args.progressReporter, PIPELINE_STEPS.blocks, {
      done: completedChapters,
      total: totalChapters,
      state: "in_progress",
      message: `Planning blocks for chapter ${chapterId}...`,
      checkpointId,
    });

    setCheckpoint(
      args.manifest,
      checkpointId,
      "in_progress",
      args.manifest.activePointers.blocksAttempts[chapterKey(chapterId)] ?? 0,
    );
    await saveManifest(args.paths.manifestPath, args.manifest);

    const prompt = buildBlocksPrompt({
      input: args.config.userInput,
      outline: args.outline,
      chapterNumber: chapterId,
    });

    try {
      const result = await withRetry(args.config.userInput.retryPolicy, async () => {
        return args.llmClient.generateJson({
          stage: `blocks:${chapterId}`,
          model,
          system,
          prompt,
          schema: StoryBlocksResultSchema,
        });
      });

      const parsed = StoryBlocksResultSchema.parse(result.object);
      const stored = await createBlocksAttemptFile(args.paths.blocksDir, chapterId, parsed);
      args.manifest.activePointers.blocksAttempts[chapterKey(chapterId)] = stored.attempt;
      setCheckpoint(args.manifest, checkpointId, "complete", stored.attempt);
      await saveManifest(args.paths.manifestPath, args.manifest);
      const done = markChapterDone();

      emitProgress(args.progressReporter, PIPELINE_STEPS.blocks, {
        done,
        total: totalChapters,
        state: done >= totalChapters ? "complete" : "in_progress",
        message: `Block plan ready for chapter ${chapterId}.`,
        checkpointId,
        checkpointPath: stored.activePath,
        checkpointUrl: toFileUrl(stored.activePath),
      });

      await appendEvent(args.paths.projectDir, {
        ts: new Date().toISOString(),
        level: "info",
        event: "stage_blocks_complete",
        details: { chapter: chapterId, attempt: stored.attempt, model },
      });

      map.set(chapterId, parsed);
    } catch (error) {
      setCheckpoint(
        args.manifest,
        checkpointId,
        "failed",
        args.manifest.activePointers.blocksAttempts[chapterKey(chapterId)] ?? 0,
        toErrorMessage(error),
      );
      await saveManifest(args.paths.manifestPath, args.manifest);
      emitProgress(args.progressReporter, PIPELINE_STEPS.blocks, {
        done: completedChapters,
        total: totalChapters,
        state: "failed",
        message: `Block planning failed for chapter ${chapterId}: ${toErrorMessage(error)}`,
        checkpointId,
      });
      throw error;
    }
  });

  if (totalChapters === 0) {
    emitProgress(args.progressReporter, PIPELINE_STEPS.blocks, {
      done: 0,
      total: 0,
      state: "complete",
      message: "No chapters required block planning.",
    });
  }

  return map;
}

async function runStageChapterDrafts(args: {
  config: AppConfig;
  paths: ReturnType<typeof getProjectPaths>;
  manifest: ProjectManifest;
  llmClient: LLMClient;
  outline: OutlineResult;
  chapterBlocks: Map<number, StoryBlocksResult>;
  progressReporter?: PipelineProgressReporter;
  modelOverride?: string;
  forceChapter?: number;
  forceBlock?: { chapterNumber: number; blockNumber: number };
}): Promise<void> {
  const system = buildSystemPrompt(args.config.userInput.systemPromptTemplate);
  const model = resolveModel(args.config, "chapter", args.modelOverride);
  const totalBlocks = args.outline.chapters.reduce((sum, chapter) => {
    return sum + (args.chapterBlocks.get(chapter.chapterNumber)?.blocks.length ?? 0);
  }, 0);
  const chapterConcurrency = Math.min(MAX_CHAPTER_CONCURRENCY, Math.max(1, args.outline.chapters.length));
  let completedBlocks = 0;
  const addCompletedBlocks = (count: number): number => {
    completedBlocks += count;
    return completedBlocks;
  };

  emitProgress(args.progressReporter, PIPELINE_STEPS.chapter_drafts, {
    done: 0,
    total: totalBlocks,
    state: "in_progress",
    message: totalBlocks > 0 ? "Drafting chapter blocks..." : "No chapter blocks to draft.",
  });

  await runWithConcurrencyLimit(args.outline.chapters, chapterConcurrency, async (chapter) => {
    const chapterNumber = chapter.chapterNumber;
    const chapterCheckpoint = checkpointIdForChapter(chapterNumber);
    const chapterStatus = getCheckpointStatus(args.manifest, chapterCheckpoint);
    const shouldForceChapter = args.forceChapter === chapterNumber;
    const chapterPlan = args.chapterBlocks.get(chapterNumber) ?? (await loadActiveChapterBlocks(args.paths.projectDir, chapterNumber));

    if (!shouldForceChapter && !args.forceBlock && chapterStatus === "complete") {
      const done = addCompletedBlocks(chapterPlan.blocks.length);
      const checkpointPath = path.join(args.paths.chapterDir, chapterKey(chapterNumber), "chapter.active.md");
      emitProgress(args.progressReporter, PIPELINE_STEPS.chapter_drafts, {
        done,
        total: totalBlocks,
        state: done >= totalBlocks ? "complete" : "skipped",
        message: `Reusing completed chapter ${chapterNumber}.`,
        checkpointId: chapterCheckpoint,
        checkpointPath,
        checkpointUrl: toFileUrl(checkpointPath),
      });
      return;
    }

    let rollingSummary = initialRollingSummary();
    let chapterText = "";
    const blockTexts: string[] = [];

    for (const block of chapterPlan.blocks) {
      const blockCheckpoint = checkpointIdForBlock(chapterNumber, block.blockNumber);
      const status = getCheckpointStatus(args.manifest, blockCheckpoint);
      const forceSpecificBlock =
        args.forceBlock?.chapterNumber === chapterNumber && args.forceBlock.blockNumber === block.blockNumber;
      const shouldForceBlock = Boolean(forceSpecificBlock);

      if (!shouldForceChapter && !shouldForceBlock && status === "complete") {
        const existing = await loadActiveBlockDraft(args.paths.projectDir, chapterNumber, block.blockNumber);
        if (existing) {
          rollingSummary = existing.updatedSummary;
          chapterText = `${chapterText}\n\n${existing.text}`.trim();
          blockTexts.push(existing.text);
          const done = addCompletedBlocks(1);
          const checkpointPath = path.join(
            args.paths.chapterDir,
            chapterKey(chapterNumber),
            `${blockKey(block.blockNumber)}.active.json`,
          );
          emitProgress(args.progressReporter, PIPELINE_STEPS.chapter_drafts, {
            done,
            total: totalBlocks,
            state: done >= totalBlocks ? "complete" : "skipped",
            message: `Reusing chapter ${chapterNumber} block ${block.blockNumber}.`,
            checkpointId: blockCheckpoint,
            checkpointPath,
            checkpointUrl: toFileUrl(checkpointPath),
          });
          continue;
        }
      }

      emitProgress(args.progressReporter, PIPELINE_STEPS.chapter_drafts, {
        done: completedBlocks,
        total: totalBlocks,
        state: "in_progress",
        message: `Drafting chapter ${chapterNumber} block ${block.blockNumber}...`,
        checkpointId: blockCheckpoint,
      });

      setCheckpoint(
        args.manifest,
        blockCheckpoint,
        "in_progress",
        args.manifest.activePointers.blockAttempts[chapterKey(chapterNumber)]?.[blockKey(block.blockNumber)] ?? 0,
      );
      await saveManifest(args.paths.manifestPath, args.manifest);

      const prompt = buildChapterBlockPrompt({
        input: args.config.userInput,
        outline: args.outline,
        chapterPlan,
        block,
        previousChapterTail: getTailByWords(chapterText, args.config.runtime.tailWindowWords),
        rollingSummary,
        isFirstBlock: block.blockNumber === 1,
      });

      try {
        const result = await withRetry(args.config.userInput.retryPolicy, async () => {
          return args.llmClient.generateJson({
            stage: `chapter:${chapterNumber}:block:${block.blockNumber}`,
            model,
            system,
            prompt,
            schema: BLOCK_DRAFT_SCHEMA,
          });
        });

        const parsed = ChapterBlockDraftSchema.parse(result.object);
        const stored = await createChapterBlockAttemptFile(
          args.paths.chapterDir,
          chapterNumber,
          block.blockNumber,
          parsed,
        );

        const chapterAttempts =
          args.manifest.activePointers.blockAttempts[chapterKey(chapterNumber)] ??
          (args.manifest.activePointers.blockAttempts[chapterKey(chapterNumber)] = {});
        chapterAttempts[blockKey(block.blockNumber)] = stored.attempt;
        setCheckpoint(args.manifest, blockCheckpoint, "complete", stored.attempt);
        await saveManifest(args.paths.manifestPath, args.manifest);
        const done = addCompletedBlocks(1);

        emitProgress(args.progressReporter, PIPELINE_STEPS.chapter_drafts, {
          done,
          total: totalBlocks,
          state: done >= totalBlocks ? "complete" : "in_progress",
          message: `Draft ready for chapter ${chapterNumber} block ${block.blockNumber}.`,
          checkpointId: blockCheckpoint,
          checkpointPath: stored.activePath,
          checkpointUrl: toFileUrl(stored.activePath),
        });

        rollingSummary = parsed.updatedSummary;
        chapterText = `${chapterText}\n\n${parsed.text}`.trim();
        blockTexts.push(parsed.text);
      } catch (error) {
        setCheckpoint(
          args.manifest,
          blockCheckpoint,
          "failed",
          args.manifest.activePointers.blockAttempts[chapterKey(chapterNumber)]?.[blockKey(block.blockNumber)] ?? 0,
          toErrorMessage(error),
        );
        await saveManifest(args.paths.manifestPath, args.manifest);
        emitProgress(args.progressReporter, PIPELINE_STEPS.chapter_drafts, {
          done: completedBlocks,
          total: totalBlocks,
          state: "failed",
          message: `Draft failed for chapter ${chapterNumber} block ${block.blockNumber}: ${toErrorMessage(error)}`,
          checkpointId: blockCheckpoint,
        });
        throw error;
      }
    }

    const markdown = buildChapterMarkdown(chapterNumber, chapter.title, buildChapterFinalizeText(blockTexts));
    const chapterStored = await createChapterAttemptFile(args.paths.chapterDir, chapterNumber, markdown);
    args.manifest.activePointers.chapterAttempts[chapterKey(chapterNumber)] = chapterStored.attempt;
    setCheckpoint(args.manifest, chapterCheckpoint, "complete", chapterStored.attempt);
    await saveManifest(args.paths.manifestPath, args.manifest);

    emitProgress(args.progressReporter, PIPELINE_STEPS.chapter_drafts, {
      done: completedBlocks,
      total: totalBlocks,
      state: completedBlocks >= totalBlocks ? "complete" : "in_progress",
      message: `Assembled chapter ${chapterNumber} markdown.`,
      checkpointId: chapterCheckpoint,
      checkpointPath: chapterStored.activePath,
      checkpointUrl: toFileUrl(chapterStored.activePath),
    });
  });

  if (totalBlocks === 0) {
    emitProgress(args.progressReporter, PIPELINE_STEPS.chapter_drafts, {
      done: 0,
      total: 0,
      state: "complete",
      message: "No chapter drafts were needed.",
    });
    return;
  }

  emitProgress(args.progressReporter, PIPELINE_STEPS.chapter_drafts, {
    done: completedBlocks,
    total: totalBlocks,
    state: "complete",
    message: "All chapter drafts are ready.",
  });
}

function normalizeArtifactsRoot(root: string): string {
  return path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
}

function projectTimestampPrefix(projectId: string): string {
  const match = projectId.match(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/);
  return match?.[0] ?? formatLocalTimestamp(new Date());
}

async function nextAvailableProjectId(
  artifactsRootAbs: string,
  desiredProjectId: string,
  currentProjectId: string,
): Promise<string> {
  if (desiredProjectId === currentProjectId) {
    return currentProjectId;
  }

  let candidate = desiredProjectId;
  let suffix = 2;
  while (true) {
    const candidateDir = getProjectPaths(artifactsRootAbs, candidate).projectDir;
    try {
      await access(candidateDir);
      candidate = `${desiredProjectId}-${suffix}`;
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

export interface RunProjectOptions {
  config: AppConfig;
  deps?: PipelineDeps;
  progressReporter?: PipelineProgressReporter;
  modelOverride?: string;
  projectId?: string;
}

export async function createAndRunProject(options: RunProjectOptions): Promise<{ projectId: string; projectDir: string }> {
  const now = options.deps?.now ?? (() => new Date());
  const projectId = options.projectId ?? createProjectId(options.config.userInput.bookTitle, now());
  const artifactsRoot = normalizeArtifactsRoot(options.config.runtime.artifactsRoot);
  const paths = getProjectPaths(artifactsRoot, projectId);
  const retitleProjectIdFromOutline = !options.projectId && !options.config.userInput.bookTitle.trim();

  await initProjectDirs(paths);
  await saveConfigAsYaml(paths.projectYamlPath, options.config);
  await writeJsonAtomic(paths.inputPath, options.config.userInput);

  const manifest = buildInitialManifest({
    projectId,
    userInput: options.config.userInput,
    runtime: options.config.runtime,
  });
  await saveManifest(paths.manifestPath, manifest);

  const finalProjectId = await runPipeline({
    artifactsRoot,
    projectId,
    retitleProjectIdFromOutline,
    ...(options.deps ? { deps: options.deps } : {}),
    ...(options.progressReporter ? { progressReporter: options.progressReporter } : {}),
    ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
  });

  return { projectId: finalProjectId, projectDir: getProjectPaths(artifactsRoot, finalProjectId).projectDir };
}

interface RunPipelineArgs {
  artifactsRoot: string;
  projectId: string;
  retitleProjectIdFromOutline?: boolean;
  deps?: PipelineDeps;
  progressReporter?: PipelineProgressReporter;
  modelOverride?: string;
  force?: {
    outline?: boolean;
    blocksChapter?: number;
    chapter?: number;
    block?: { chapterNumber: number; blockNumber: number };
  };
}

export async function runPipeline(args: RunPipelineArgs): Promise<string> {
  const artifactsRoot = normalizeArtifactsRoot(args.artifactsRoot);
  let projectId = args.projectId;
  let paths = getProjectPaths(artifactsRoot, projectId);
  const config = await readProjectConfig(paths.projectYamlPath);
  const manifest = await loadManifest(paths.manifestPath);
  const llmClient = args.deps?.llmClient ?? createOpenRouterLLMClient();

  const outline = await runStageOutline({
    config,
    paths,
    manifest,
    llmClient,
    ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}),
    ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
    ...(args.force?.outline ? { force: true } : {}),
  });

  const resolvedBookTitle = outline.bookTitle.trim();
  if (resolvedBookTitle) {
    config.userInput.bookTitle = resolvedBookTitle;

    if (args.retitleProjectIdFromOutline) {
      const desiredProjectId = `${projectTimestampPrefix(projectId)}_${slugify(resolvedBookTitle) || "untitled-book"}`;
      const finalProjectId = await nextAvailableProjectId(artifactsRoot, desiredProjectId, projectId);
      if (finalProjectId !== projectId) {
        await rename(paths.projectDir, getProjectPaths(artifactsRoot, finalProjectId).projectDir);
        projectId = finalProjectId;
        paths = getProjectPaths(artifactsRoot, projectId);
      }
    }

    manifest.projectId = projectId;
    manifest.bookTitle = resolvedBookTitle;
    await saveConfigAsYaml(paths.projectYamlPath, config);
    await writeJsonAtomic(paths.inputPath, config.userInput);
    await saveManifest(paths.manifestPath, manifest);
  }

  const blocks = await runStageBlocks({
    config,
    paths,
    manifest,
    llmClient,
    outline,
    ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}),
    ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
    ...(typeof args.force?.blocksChapter === "number" ? { forceChapter: args.force.blocksChapter } : {}),
  });

  await runStageChapterDrafts({
    config,
    paths,
    manifest,
    llmClient,
    outline,
    chapterBlocks: blocks,
    ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}),
    ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
    ...(typeof args.force?.chapter === "number" ? { forceChapter: args.force.chapter } : {}),
    ...(args.force?.block ? { forceBlock: args.force.block } : {}),
  });

  await exportProjectEpub({
    artifactsRoot,
    projectId,
    ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}),
  });

  return projectId;
}

async function readProjectConfig(configPath: string): Promise<AppConfig> {
  const source = await readFile(configPath, "utf-8");
  const parsed = YAML.load(source);
  return AppConfigSchema.parse(parsed);
}

export async function resumeProject(args: {
  artifactsRoot: string;
  projectId?: string;
  deps?: PipelineDeps;
  progressReporter?: PipelineProgressReporter;
  modelOverride?: string;
}): Promise<string> {
  const resolvedProjectId = args.projectId ?? (await findMostRecentIncompleteProjectId(args.artifactsRoot));
  if (!resolvedProjectId) {
    throw new Error("No incomplete projects found. Pass --project-id to resume a specific project.");
  }

  await runPipeline({
    ...args,
    projectId: resolvedProjectId,
  });
  return resolvedProjectId;
}

function setPending(manifest: ProjectManifest, id: string): void {
  const existing = manifest.checkpoints[id];
  manifest.checkpoints[id] = {
    status: "pending",
    attempt: existing?.attempt ?? 0,
    updatedAt: new Date().toISOString(),
  };
}

function invalidateDownstreamForChapter(manifest: ProjectManifest, chapterNumber: number): void {
  setPending(manifest, checkpointIdForBlocks(chapterNumber));
  setPending(manifest, checkpointIdForChapter(chapterNumber));

  for (const [id, checkpoint] of Object.entries(manifest.checkpoints)) {
    if (id.startsWith(`stage3:block:${chapterKey(chapterNumber)}:`)) {
      manifest.checkpoints[id] = {
        status: "pending",
        attempt: checkpoint.attempt,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  setPending(manifest, checkpointIdForExportEpub());
}

function invalidateForTarget(manifest: ProjectManifest, target: "outline" | "blocks" | "chapter" | "block", chapter?: number, block?: number): void {
  if (target === "outline") {
    for (const id of Object.keys(manifest.checkpoints)) {
      setPending(manifest, id);
    }
    return;
  }

  if (target === "blocks") {
    if (chapter) {
      invalidateDownstreamForChapter(manifest, chapter);
      return;
    }

    for (const id of Object.keys(manifest.checkpoints)) {
      if (id.startsWith("stage2:blocks:") || id.startsWith("stage3:")) {
        setPending(manifest, id);
      }
    }
    setPending(manifest, checkpointIdForExportEpub());
    return;
  }

  if (target === "chapter") {
    if (!chapter) {
      throw new Error("chapter is required for target=chapter");
    }

    setPending(manifest, checkpointIdForChapter(chapter));
    for (const id of Object.keys(manifest.checkpoints)) {
      if (id.startsWith(`stage3:block:${chapterKey(chapter)}:`)) {
        setPending(manifest, id);
      }
    }
    setPending(manifest, checkpointIdForExportEpub());
    return;
  }

  if (!chapter || !block) {
    throw new Error("chapter and block are required for target=block");
  }
  setPending(manifest, checkpointIdForBlock(chapter, block));
  setPending(manifest, checkpointIdForChapter(chapter));
  setPending(manifest, checkpointIdForExportEpub());
}

export async function regenerateProject(args: {
  artifactsRoot: string;
  projectId: string;
  target: "outline" | "blocks" | "chapter" | "block";
  chapter?: number;
  block?: number;
  deps?: PipelineDeps;
  progressReporter?: PipelineProgressReporter;
  modelOverride?: string;
}): Promise<void> {
  const artifactsRoot = normalizeArtifactsRoot(args.artifactsRoot);
  const paths = getProjectPaths(artifactsRoot, args.projectId);
  const manifest = await loadManifest(paths.manifestPath);

  invalidateForTarget(manifest, args.target, args.chapter, args.block);
  await saveManifest(paths.manifestPath, manifest);

  await runPipeline({
    artifactsRoot,
    projectId: args.projectId,
    ...(args.deps ? { deps: args.deps } : {}),
    ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}),
    ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
    force: {
      ...(args.target === "outline" ? { outline: true } : {}),
      ...(args.target === "blocks" && typeof args.chapter === "number" ? { blocksChapter: args.chapter } : {}),
      ...(args.target === "chapter" && typeof args.chapter === "number" ? { chapter: args.chapter } : {}),
      ...(args.target === "block" && typeof args.chapter === "number" && typeof args.block === "number"
        ? { block: { chapterNumber: args.chapter, blockNumber: args.block } }
        : {}),
    },
  });
}

export interface ExportProgressStep {
  stepIndex: number;
  stepCount: number;
  stepLabel?: string;
}

export async function exportProjectEpub(args: {
  artifactsRoot: string;
  projectId: string;
  progressReporter?: PipelineProgressReporter;
  progressStep?: ExportProgressStep;
}): Promise<string> {
  const artifactsRoot = normalizeArtifactsRoot(args.artifactsRoot);
  const paths = getProjectPaths(artifactsRoot, args.projectId);
  const manifest = await loadManifest(paths.manifestPath);
  const exportStepMeta: PipelineStepMeta = {
    id: PIPELINE_STEPS.export_epub.id,
    label: args.progressStep?.stepLabel ?? PIPELINE_STEPS.export_epub.label,
    index: args.progressStep?.stepIndex ?? PIPELINE_STEPS.export_epub.index,
    count: args.progressStep?.stepCount ?? PIPELINE_STEPS.export_epub.count,
  };
  const checkpointId = checkpointIdForExportEpub();

  emitProgress(args.progressReporter, exportStepMeta, {
    done: 0,
    total: 1,
    state: "in_progress",
    message: "Packaging EPUB export...",
    checkpointId,
  });

  const epubPath = await exportStyledEpub({
    projectDir: paths.projectDir,
    exportDir: paths.exportDir,
    slug: slugify(manifest.bookTitle) || "book",
    metadata: {
      title: manifest.bookTitle,
      author: manifest.author,
      language: manifest.language,
      description: `Generated novel project ${manifest.projectId}`,
    },
  });

  setCheckpoint(manifest, checkpointId, "complete", 1);
  await saveManifest(paths.manifestPath, manifest);

  emitProgress(args.progressReporter, exportStepMeta, {
    done: 1,
    total: 1,
    state: "complete",
    message: "EPUB export complete.",
    checkpointId,
    checkpointPath: epubPath,
    checkpointUrl: toFileUrl(epubPath),
  });

  return epubPath;
}

export interface ProjectStatus {
  projectId: string;
  bookTitle: string;
  createdAt: string;
  updatedAt: string;
  checkpointCounts: Record<CheckpointStatus, number>;
}

export async function getProjectStatus(args: { artifactsRoot: string; projectId: string }): Promise<ProjectStatus> {
  const artifactsRoot = normalizeArtifactsRoot(args.artifactsRoot);
  const paths = getProjectPaths(artifactsRoot, args.projectId);
  const manifest = await loadManifest(paths.manifestPath);

  const counts: Record<CheckpointStatus, number> = {
    pending: 0,
    in_progress: 0,
    complete: 0,
    failed: 0,
  };

  for (const checkpoint of Object.values(manifest.checkpoints)) {
    counts[checkpoint.status] += 1;
  }

  return {
    projectId: manifest.projectId,
    bookTitle: manifest.bookTitle,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    checkpointCounts: counts,
  };
}

export async function listProjects(artifactsRoot: string): Promise<string[]> {
  const root = normalizeArtifactsRoot(artifactsRoot);
  await ensureDir(root);

  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function isIncompleteProject(manifest: ProjectManifest): boolean {
  const checkpoints = Object.values(manifest.checkpoints);
  if (checkpoints.length === 0) {
    return true;
  }
  return checkpoints.some((checkpoint) => checkpoint.status !== "complete");
}

export async function findMostRecentIncompleteProjectId(artifactsRoot: string): Promise<string | null> {
  const root = normalizeArtifactsRoot(artifactsRoot);
  const projectIds = await listProjects(root);

  const candidates = await Promise.all(
    projectIds.map(async (projectId) => {
      const paths = getProjectPaths(root, projectId);
      try {
        const manifest = await loadManifest(paths.manifestPath);
        if (!isIncompleteProject(manifest)) {
          return null;
        }

        const updatedAtMs = Date.parse(manifest.updatedAt);
        return {
          projectId,
          updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : Number.NEGATIVE_INFINITY,
        };
      } catch {
        return null;
      }
    }),
  );

  const mostRecent = candidates
    .filter((candidate): candidate is { projectId: string; updatedAtMs: number } => candidate !== null)
    .sort((a, b) => {
      if (b.updatedAtMs !== a.updatedAtMs) {
        return b.updatedAtMs - a.updatedAtMs;
      }
      return b.projectId.localeCompare(a.projectId);
    })[0];

  return mostRecent?.projectId ?? null;
}

export function buildDefaultRetryPolicy(): RetryPolicy {
  return {
    maxRetries: 3,
    baseDelayMs: 750,
    maxDelayMs: 8_000,
    jitterRatio: 0.15,
  };
}
