import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

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
import { blockKey, chapterKey, createProjectId, slugify } from "../utils/ids.js";
import { appendEvent } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";

export interface PipelineDeps {
  llmClient?: LLMClient;
  now?: () => Date;
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

async function loadActiveOutline(projectDir: string): Promise<OutlineResult> {
  const filePath = path.join(projectDir, "stage1-outline", "active.json");
  const parsed = await readJsonFile<unknown>(filePath);
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
  modelOverride?: string;
  force?: boolean;
}): Promise<OutlineResult> {
  const checkpointId = checkpointIdForOutline();
  const currentStatus = getCheckpointStatus(args.manifest, checkpointId);
  if (!args.force && currentStatus === "complete") {
    return loadActiveOutline(args.paths.projectDir);
  }

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
    throw error;
  }
}

async function runStageBlocks(args: {
  config: AppConfig;
  paths: ReturnType<typeof getProjectPaths>;
  manifest: ProjectManifest;
  llmClient: LLMClient;
  outline: OutlineResult;
  modelOverride?: string;
  forceChapter?: number;
}): Promise<Map<number, StoryBlocksResult>> {
  const map = new Map<number, StoryBlocksResult>();
  const system = buildSystemPrompt(args.config.userInput.systemPromptTemplate);
  const model = resolveModel(args.config, "blocks", args.modelOverride);

  for (const chapter of args.outline.chapters) {
    const chapterId = chapter.chapterNumber;
    const checkpointId = checkpointIdForBlocks(chapterId);
    const status = getCheckpointStatus(args.manifest, checkpointId);

    if (!args.forceChapter && status === "complete") {
      map.set(chapterId, await loadActiveChapterBlocks(args.paths.projectDir, chapterId));
      continue;
    }

    if (args.forceChapter && args.forceChapter !== chapterId && status === "complete") {
      map.set(chapterId, await loadActiveChapterBlocks(args.paths.projectDir, chapterId));
      continue;
    }

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
      throw error;
    }
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
  modelOverride?: string;
  forceChapter?: number;
  forceBlock?: { chapterNumber: number; blockNumber: number };
}): Promise<void> {
  const system = buildSystemPrompt(args.config.userInput.systemPromptTemplate);
  const model = resolveModel(args.config, "chapter", args.modelOverride);

  for (const chapter of args.outline.chapters) {
    const chapterNumber = chapter.chapterNumber;
    const chapterCheckpoint = checkpointIdForChapter(chapterNumber);
    const chapterStatus = getCheckpointStatus(args.manifest, chapterCheckpoint);
    const shouldForceChapter = args.forceChapter === chapterNumber;

    if (!shouldForceChapter && !args.forceBlock && chapterStatus === "complete") {
      continue;
    }

    const chapterPlan = args.chapterBlocks.get(chapterNumber) ?? (await loadActiveChapterBlocks(args.paths.projectDir, chapterNumber));
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
          continue;
        }
      }

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
        throw error;
      }
    }

    const markdown = buildChapterMarkdown(chapterNumber, chapter.title, buildChapterFinalizeText(blockTexts));
    const chapterStored = await createChapterAttemptFile(args.paths.chapterDir, chapterNumber, markdown);
    args.manifest.activePointers.chapterAttempts[chapterKey(chapterNumber)] = chapterStored.attempt;
    setCheckpoint(args.manifest, chapterCheckpoint, "complete", chapterStored.attempt);
    await saveManifest(args.paths.manifestPath, args.manifest);
  }
}

function normalizeArtifactsRoot(root: string): string {
  return path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
}

export interface RunProjectOptions {
  config: AppConfig;
  deps?: PipelineDeps;
  modelOverride?: string;
  projectId?: string;
}

export async function createAndRunProject(options: RunProjectOptions): Promise<{ projectId: string; projectDir: string }> {
  const now = options.deps?.now ?? (() => new Date());
  const projectId = options.projectId ?? createProjectId(options.config.userInput.bookTitle, now());
  const artifactsRoot = normalizeArtifactsRoot(options.config.runtime.artifactsRoot);
  const paths = getProjectPaths(artifactsRoot, projectId);

  await initProjectDirs(paths);
  await saveConfigAsYaml(paths.projectYamlPath, options.config);
  await writeJsonAtomic(paths.inputPath, options.config.userInput);

  const manifest = buildInitialManifest({
    projectId,
    userInput: options.config.userInput,
    runtime: options.config.runtime,
  });
  await saveManifest(paths.manifestPath, manifest);

  await runPipeline({
    artifactsRoot,
    projectId,
    ...(options.deps ? { deps: options.deps } : {}),
    ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
  });

  return { projectId, projectDir: paths.projectDir };
}

interface RunPipelineArgs {
  artifactsRoot: string;
  projectId: string;
  deps?: PipelineDeps;
  modelOverride?: string;
  force?: {
    outline?: boolean;
    blocksChapter?: number;
    chapter?: number;
    block?: { chapterNumber: number; blockNumber: number };
  };
}

export async function runPipeline(args: RunPipelineArgs): Promise<void> {
  const artifactsRoot = normalizeArtifactsRoot(args.artifactsRoot);
  const paths = getProjectPaths(artifactsRoot, args.projectId);
  const config = await readProjectConfig(paths.projectYamlPath);
  const manifest = await loadManifest(paths.manifestPath);
  const llmClient = args.deps?.llmClient ?? createOpenRouterLLMClient();

  const outline = await runStageOutline({
    config,
    paths,
    manifest,
    llmClient,
    ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
    ...(args.force?.outline ? { force: true } : {}),
  });

  const blocks = await runStageBlocks({
    config,
    paths,
    manifest,
    llmClient,
    outline,
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
    ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
    ...(typeof args.force?.chapter === "number" ? { forceChapter: args.force.chapter } : {}),
    ...(args.force?.block ? { forceBlock: args.force.block } : {}),
  });

  await exportProjectEpub({
    artifactsRoot,
    projectId: args.projectId,
  });
}

async function readProjectConfig(configPath: string): Promise<AppConfig> {
  const source = await readFile(configPath, "utf-8");
  const parsed = YAML.load(source);
  return AppConfigSchema.parse(parsed);
}

export async function resumeProject(args: {
  artifactsRoot: string;
  projectId: string;
  deps?: PipelineDeps;
  modelOverride?: string;
}): Promise<void> {
  await runPipeline(args);
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

export async function exportProjectEpub(args: { artifactsRoot: string; projectId: string }): Promise<string> {
  const artifactsRoot = normalizeArtifactsRoot(args.artifactsRoot);
  const paths = getProjectPaths(artifactsRoot, args.projectId);
  const manifest = await loadManifest(paths.manifestPath);

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

  setCheckpoint(manifest, checkpointIdForExportEpub(), "complete", 1);
  await saveManifest(paths.manifestPath, manifest);

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

export function buildDefaultRetryPolicy(): RetryPolicy {
  return {
    maxRetries: 3,
    baseDelayMs: 750,
    maxDelayMs: 8_000,
    jitterRatio: 0.15,
  };
}
