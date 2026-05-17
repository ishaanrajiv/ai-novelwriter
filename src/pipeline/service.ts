import { access, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";

import YAML from "js-yaml";
import { z } from "zod";

import { saveConfigAsYaml } from "../config/index.js";
import { ensureProviderEnv } from "../env/bootstrap.js";
import { createLLMClient, type JsonGenerationOptions, type LLMClient, type TextGenerationOptions } from "../llm/provider.js";
import {
  STAGE_IDS,
  buildBlockDraftPrompt,
  buildContextRequestPrompt,
  buildCriticPrompt,
  buildGlobalRevisionPrompt,
  buildMemoryUpdatePrompt,
  buildOutlinePrompt,
  buildPlannerPrompt,
  buildPremiseExpansionPrompt,
  buildReviserPrompt,
  buildStoryBlocksPrompt,
  buildStoryBibleUpdatePrompt,
  buildSummaryPrompt,
  buildSystemPrompt,
  getTailByWords,
  type StageId,
} from "../llm/prompts.js";
import { exportStyledEpub } from "../output/epub.js";
import { buildChapterMarkdown } from "../output/markdown.js";
import {
  AppConfigSchema,
  ContextRequestSchema,
  OutlineResultSchema,
  ResolvedContextSchema,
  RollingSummarySchema,
  StoryBibleStateSchema,
  StoryBlocksResultSchema,
  type AppConfig,
  type ProjectManifest,
} from "../schemas/contracts.js";
import {
  buildInitialManifest,
  checkpointIdForChapter,
  checkpointIdForExportEpub,
  checkpointIdForStage,
  createChapterPassFile,
  createStageAttemptFile,
  createStageTextAttemptFile,
  getCheckpointStatus,
  getProjectPaths,
  initProjectDirs,
  loadManifest,
  saveManifest,
  setCheckpoint,
} from "../state/manifest.js";
import { wrapLLMClientWithUsageLogging } from "../state/usage.js";
import type { CheckpointStatus, RetryPolicy } from "../types/index.js";
import { ensureDir, readJsonFile, writeJsonAtomic, writeTextAtomic } from "../utils/fs.js";
import { chapterKey, createProjectId, formatLocalTimestamp, slugify } from "../utils/ids.js";
import { appendEvent, appendFailure } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";

export interface PipelineDeps { llmClient?: LLMClient; now?: () => Date }
export type PipelineStepId = "premise_expansion" | "story_summary" | "chapter_outline" | "chapter_loop" | "global_revision" | "export_epub";
export type PipelineStepState = "in_progress" | "complete" | "skipped" | "failed";
export interface PipelineLLMActivityEvent { active: boolean; inFlight: number; stage?: string }
export interface PipelineProgressEvent {
  stepId: PipelineStepId; stepLabel: string; stepIndex: number; stepCount: number;
  done: number; total: number; state: PipelineStepState; message: string;
  checkpointId?: string; checkpointPath?: string; checkpointUrl?: string;
}
export interface PipelineProgressReporter {
  onProgress(event: PipelineProgressEvent): void;
  onLLMActivity?(event: PipelineLLMActivityEvent): void;
}

interface PipelineStepMeta { id: PipelineStepId; label: string; index: number; count: number }
const PIPELINE_STEPS: Record<PipelineStepId, PipelineStepMeta> = {
  premise_expansion: { id: "premise_expansion", label: "Premise Expansion", index: 1, count: 6 },
  story_summary: { id: "story_summary", label: "Story Summary", index: 2, count: 6 },
  chapter_outline: { id: "chapter_outline", label: "Chapter Outline", index: 3, count: 6 },
  chapter_loop: { id: "chapter_loop", label: "Chapter Loop", index: 4, count: 6 },
  global_revision: { id: "global_revision", label: "Global Revision", index: 5, count: 6 },
  export_epub: { id: "export_epub", label: "EPUB Export", index: 6, count: 6 },
};

export class PipelineRunError extends Error {
  readonly projectId: string;
  readonly projectDir: string;
  readonly stepId?: PipelineStepId;
  readonly checkpointId?: string;

  constructor(message: string, args: { projectId: string; projectDir: string; stepId?: PipelineStepId; checkpointId?: string }) {
    super(message);
    this.name = "PipelineRunError";
    this.projectId = args.projectId;
    this.projectDir = args.projectDir;
    if (args.stepId) this.stepId = args.stepId;
    if (args.checkpointId) this.checkpointId = args.checkpointId;
  }
}

function toFileUrl(filePath: string): string { return pathToFileURL(filePath).toString(); }
function emitProgress(reporter: PipelineProgressReporter | undefined, step: PipelineStepMeta, event: Omit<PipelineProgressEvent, "stepId" | "stepLabel" | "stepIndex" | "stepCount">): void {
  if (!reporter) return;
  reporter.onProgress({ stepId: step.id, stepLabel: step.label, stepIndex: step.index, stepCount: step.count, ...event });
}
function wrapLLMClientWithProgressActivity(args: { llmClient: LLMClient; progressReporter?: PipelineProgressReporter }): LLMClient {
  const { llmClient, progressReporter } = args;
  let inFlight = 0;

  const notify = (stage?: string): void => {
    progressReporter?.onLLMActivity?.({ active: inFlight > 0, inFlight, ...(stage ? { stage } : {}) });
  };

  const start = (stage?: string): void => {
    inFlight += 1;
    notify(stage);
  };

  const finish = (stage?: string): void => {
    inFlight = Math.max(0, inFlight - 1);
    notify(stage);
  };

  return {
    async generateText(options: TextGenerationOptions) {
      start(options.stage);
      try {
        return await llmClient.generateText(options);
      } finally {
        finish(options.stage);
      }
    },
    async generateJson<T>(options: JsonGenerationOptions<T>) {
      start(options.stage);
      try {
        return await llmClient.generateJson<T>(options);
      } finally {
        finish(options.stage);
      }
    },
  };
}
function toErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function normalizeArtifactsRoot(root: string): string { return path.isAbsolute(root) ? root : path.resolve(process.cwd(), root); }
function projectTimestampPrefix(projectId: string): string { const m = projectId.match(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/); return m?.[0] ?? formatLocalTimestamp(new Date()); }

function resolveModel(config: AppConfig, stage: "outline" | "chapter" | "memory", override?: string): string {
  if (override) return override;
  const m = config.userInput.modelConfig;
  if (stage === "outline") return m.outlineModel ?? m.defaultModel;
  if (stage === "chapter") return m.chapterModel ?? m.defaultModel;
  return m.memoryModel ?? m.chapterModel ?? m.defaultModel;
}

function resolveIterativeStageModel(config: AppConfig, stageId: StageId, override?: string): string {
  if (stageId === "premise_expansion" || stageId === "story_summary") {
    return resolveModel(config, "outline", override);
  }
  if (stageId === "global_revision") {
    return resolveModel(config, "chapter", override);
  }
  return resolveModel(config, "memory", override);
}

const CRITIC_SCHEMA = z.object({ score: z.number().min(0).max(1), notes: z.string().min(1) });

function hasConverged(deltas: number[], windowSize: number, threshold: number): boolean {
  if (deltas.length < windowSize) return false;
  const tail = deltas.slice(-windowSize);
  // Treat convergence as a mostly-flat tail instead of requiring every delta
  // to be below threshold. This avoids over-iterating when one pass spikes.
  const avg = tail.reduce((sum, d) => sum + d, 0) / tail.length;
  const max = Math.max(...tail);
  return avg <= threshold && max <= threshold * 2;
}

function normalizeForDiff(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildCharNgrams(text: string, size = 5): Set<string> {
  const grams = new Set<string>();
  if (text.length <= size) {
    if (text) grams.add(text);
    return grams;
  }
  for (let i = 0; i <= text.length - size; i += 1) {
    grams.add(text.slice(i, i + size));
  }
  return grams;
}

function textChangeRatio(previous: string, next: string): number {
  const a = normalizeForDiff(previous);
  const b = normalizeForDiff(next);
  if (!a && !b) return 0;
  if (a === b) return 0;
  const gramsA = buildCharNgrams(a);
  const gramsB = buildCharNgrams(b);
  const unionSize = new Set([...gramsA, ...gramsB]).size;
  if (unionSize === 0) return 0;
  let intersectionSize = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) intersectionSize += 1;
  }
  const similarity = intersectionSize / unionSize;
  return Math.max(0, 1 - similarity);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseJsonFromText(input: string): unknown {
  const trimmed = input.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try fenced code block first.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1]);
    }

    // Fallback: take the first plausible JSON object span.
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const slice = trimmed.slice(firstBrace, lastBrace + 1);
      return JSON.parse(slice);
    }
    throw new Error("No JSON object found in model output.");
  }
}

function normalizeOutlineCandidate(raw: unknown, chapterCount: number, targetWordCount: number): z.infer<typeof OutlineResultSchema> {
  const obj = asObject(raw);
  if (!obj) return OutlineResultSchema.parse(raw);

  const chaptersRaw = Array.isArray(obj.chapters) ? obj.chapters : [];
  const perChapterDefault = Math.max(300, Math.round(targetWordCount / Math.max(1, chapterCount)));
  const normalizedChapters = chaptersRaw.map((chapterValue, index) => {
    const chapter = asObject(chapterValue) ?? {};
    const targetWordsGuideline =
      asNumber(chapter.targetWordsGuideline)
      ?? asNumber(chapter.targetWords)
      ?? asNumber(chapter.wordTarget)
      ?? asNumber(chapter.wordCountTarget)
      ?? asNumber(chapter.target_words)
      ?? perChapterDefault;

    return {
      chapterNumber: asNumber(chapter.chapterNumber) ?? index + 1,
      title: typeof chapter.title === "string" ? chapter.title : `Chapter ${index + 1}`,
      summary: typeof chapter.summary === "string" ? chapter.summary : "",
      targetWordsGuideline,
    };
  });

  const normalized = {
    bookTitle: typeof obj.bookTitle === "string" ? obj.bookTitle : "",
    globalStoryArc:
      (typeof obj.globalStoryArc === "string" ? obj.globalStoryArc : null)
      ?? (typeof obj.globalArc === "string" ? obj.globalArc : null)
      ?? (typeof obj.storyArc === "string" ? obj.storyArc : null)
      ?? (typeof obj.arc === "string" ? obj.arc : null)
      ?? "",
    chapters: normalizedChapters,
  };

  return OutlineResultSchema.parse(normalized);
}

function normalizeStoryBlocksCandidate(
  raw: unknown,
  chapterNumber: number,
  chapterTitle: string,
  minBlocks: number,
  maxBlocks: number,
  chapterTargetWords: number,
): z.infer<typeof StoryBlocksResultSchema> {
  const obj = asObject(raw);
  if (!obj) return StoryBlocksResultSchema.parse(raw);

  const blocksRaw =
    (Array.isArray(obj.blocks) ? obj.blocks : null)
    ?? (Array.isArray(obj.scenes) ? obj.scenes : null)
    ?? (Array.isArray(obj.chapterBlocks) ? obj.chapterBlocks : null)
    ?? [];

  const desiredCount = Math.min(maxBlocks, Math.max(minBlocks, blocksRaw.length || minBlocks));
  const perBlockWords = Math.max(120, Math.round(chapterTargetWords / Math.max(1, desiredCount)));

  const normalizedBlocks = blocksRaw.map((blockValue, index) => {
    const block = asObject(blockValue) ?? {};
    const eventsValue = block.events ?? block.beats ?? block.keyEvents;
    const charactersValue = block.characters ?? block.participants;
    const continuityValue = block.continuityNotes ?? block.continuity ?? block.constraints;

    const toStrings = (value: unknown, fallback?: string): string[] => {
      if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (typeof value === "string" && value.trim()) return [value.trim()];
      return fallback ? [fallback] : [];
    };

    return {
      blockNumber: asNumber(block.blockNumber) ?? asNumber(block.sceneNumber) ?? asNumber(block.number) ?? index + 1,
      goal:
        (typeof block.goal === "string" ? block.goal : null)
        ?? (typeof block.objective === "string" ? block.objective : null)
        ?? (typeof block.summary === "string" ? block.summary : null)
        ?? `Advance chapter conflict in block ${index + 1}.`,
      events: toStrings(eventsValue, "Escalate chapter tension."),
      characters: toStrings(charactersValue),
      continuityNotes: toStrings(continuityValue),
      targetWordsGuideline:
        asNumber(block.targetWordsGuideline)
        ?? asNumber(block.targetWords)
        ?? asNumber(block.wordTarget)
        ?? asNumber(block.target_words)
        ?? perBlockWords,
    };
  });

  const normalized = {
    chapterNumber:
      asNumber(obj.chapterNumber)
      ?? asNumber(obj.chapter)
      ?? chapterNumber,
    chapterTitle:
      (typeof obj.chapterTitle === "string" ? obj.chapterTitle : null)
      ?? (typeof obj.title === "string" ? obj.title : null)
      ?? chapterTitle,
    blocks: normalizedBlocks,
  };

  return StoryBlocksResultSchema.parse(normalized);
}

function formatRollingSummary(summary: z.infer<typeof RollingSummarySchema> | null): string {
  if (!summary) return "";
  return [
    `Plot state: ${summary.plotState}`,
    `Character state: ${summary.characterState}`,
    `Open loops: ${summary.openLoops.join("; ") || "None"}`,
    `Style constraints: ${summary.styleConstraints.join("; ") || "None"}`,
  ].join("\n");
}

async function seedStoryBible(paths: ReturnType<typeof getProjectPaths>, outline: z.infer<typeof OutlineResultSchema>): Promise<void> {
  const base = {
    bookTitle: outline.bookTitle,
    globalStoryArc: outline.globalStoryArc,
    chapters: outline.chapters.map((chapter) => ({ chapterNumber: chapter.chapterNumber, title: chapter.title, summary: chapter.summary })),
  };
  await writeJsonAtomic(paths.storyBibleCharactersPath, { ...base, characters: [] });
  await writeJsonAtomic(paths.storyBibleEventsPath, { ...base, events: [] });
  await writeJsonAtomic(paths.storyBibleWorldPath, { ...base, worldRules: [] });
  await writeJsonAtomic(paths.storyBibleStylePath, { styleAnchors: [] });
}

function formatStoryBibleState(storyBible: z.infer<typeof StoryBibleStateSchema>): string {
  return [
    `Characters: ${storyBible.characters.join(" | ") || "None"}`,
    `Events: ${storyBible.events.join(" | ") || "None"}`,
    `World rules: ${storyBible.worldRules.join(" | ") || "None"}`,
    `Style anchors: ${storyBible.styleAnchors.join(" | ") || "None"}`,
  ].join("\n");
}

async function loadStoryBibleState(paths: ReturnType<typeof getProjectPaths>): Promise<z.infer<typeof StoryBibleStateSchema>> {
  const [charactersPayload, eventsPayload, worldPayload, stylePayload] = await Promise.all([
    readJsonFile<Record<string, unknown>>(paths.storyBibleCharactersPath),
    readJsonFile<Record<string, unknown>>(paths.storyBibleEventsPath),
    readJsonFile<Record<string, unknown>>(paths.storyBibleWorldPath),
    readJsonFile<Record<string, unknown>>(paths.storyBibleStylePath),
  ]);
  return StoryBibleStateSchema.parse({
    characters: Array.isArray(charactersPayload.characters) ? charactersPayload.characters : [],
    events: Array.isArray(eventsPayload.events) ? eventsPayload.events : [],
    worldRules: Array.isArray(worldPayload.worldRules) ? worldPayload.worldRules : [],
    styleAnchors: Array.isArray(stylePayload.styleAnchors) ? stylePayload.styleAnchors : [],
  });
}

async function saveStoryBibleState(paths: ReturnType<typeof getProjectPaths>, outline: z.infer<typeof OutlineResultSchema>, storyBible: z.infer<typeof StoryBibleStateSchema>): Promise<void> {
  const base = {
    bookTitle: outline.bookTitle,
    globalStoryArc: outline.globalStoryArc,
    chapters: outline.chapters.map((chapter) => ({ chapterNumber: chapter.chapterNumber, title: chapter.title, summary: chapter.summary })),
  };
  await Promise.all([
    writeJsonAtomic(paths.storyBibleCharactersPath, { ...base, characters: storyBible.characters }),
    writeJsonAtomic(paths.storyBibleEventsPath, { ...base, events: storyBible.events }),
    writeJsonAtomic(paths.storyBibleWorldPath, { ...base, worldRules: storyBible.worldRules }),
    writeJsonAtomic(paths.storyBibleStylePath, { styleAnchors: storyBible.styleAnchors }),
  ]);
}

async function resolveContext(paths: ReturnType<typeof getProjectPaths>, contextRequest: z.infer<typeof ContextRequestSchema>): Promise<z.infer<typeof ResolvedContextSchema>> {
  const [charactersPayload, eventsPayload, worldPayload, stylePayload] = await Promise.all([
    readJsonFile<Record<string, unknown>>(paths.storyBibleCharactersPath),
    readJsonFile<Record<string, unknown>>(paths.storyBibleEventsPath),
    readJsonFile<Record<string, unknown>>(paths.storyBibleWorldPath),
    readJsonFile<Record<string, unknown>>(paths.storyBibleStylePath),
  ]);

  const toLines = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  const resolved = ResolvedContextSchema.parse({
    characterContext: toLines(charactersPayload.characters).filter((line) => contextRequest.neededCharacters.length === 0 || contextRequest.neededCharacters.some((name) => line.toLowerCase().includes(name.toLowerCase()))),
    eventContext: toLines(eventsPayload.events).filter((line) => contextRequest.neededEvents.length === 0 || contextRequest.neededEvents.some((name) => line.toLowerCase().includes(name.toLowerCase()))),
    worldContext: toLines(worldPayload.worldRules).filter((line) => contextRequest.neededWorldRules.length === 0 || contextRequest.neededWorldRules.some((name) => line.toLowerCase().includes(name.toLowerCase()))),
    continuityAnswers: contextRequest.continuityQuestions.map((question) => `Pending continuity check: ${question}`),
    carryForwardConstraints: toLines(stylePayload.styleAnchors),
  });
  return resolved;
}

async function plannerRationale(llmClient: LLMClient, system: string, model: string, stageId: StageId, pass: number, score: number, delta: number, nextStageId: StageId): Promise<string> {
  const prompt = buildPlannerPrompt({ stageId, pass, score, delta, nextStageId });
  const result = await llmClient.generateText({ stage: `planner:${stageId}:${pass}`, model, system, prompt });
  return result.text.trim() || `Advance from ${stageId} to ${nextStageId}`;
}

async function runIterativeTextStage(args: {
  stageId: StageId;
  stageDir: string;
  checkpointId: string;
  promptBuilder: () => Promise<string> | string;
  config: AppConfig;
  paths: ReturnType<typeof getProjectPaths>;
  manifest: ProjectManifest;
  llmClient: LLMClient;
  progressReporter?: PipelineProgressReporter;
  modelOverride?: string;
  force?: boolean;
}): Promise<string> {
  const step = PIPELINE_STEPS[args.stageId as PipelineStepId];
  const activePath = path.join(args.stageDir, "active.md");
  if (!args.force && getCheckpointStatus(args.manifest, args.checkpointId) === "complete") {
    const text = await readFile(activePath, "utf-8");
    emitProgress(args.progressReporter, step, { done: 1, total: 1, state: "skipped", message: `Reusing ${args.stageId}.`, checkpointId: args.checkpointId, checkpointPath: activePath, checkpointUrl: toFileUrl(activePath) });
    return text;
  }

  const deltas: number[] = [];
  let pass = 0;
  let current = "";
  let previousEvaluated = "";
  let score = 0;
  let initialPrompt = "";
  let premiseRevisionNotes = "";
  const system = buildSystemPrompt(args.config.userInput.systemPromptTemplate);
  const model = resolveIterativeStageModel(args.config, args.stageId, args.modelOverride);

  while (true) {
    pass += 1;
    const minPassesMetForStagnation = pass >= args.config.userInput.iterationPolicy.minPassesPerStage;
    const stagnationWindowStarted = pass >= args.config.userInput.iterationPolicy.stagnationPassStart;
    if (previousEvaluated && minPassesMetForStagnation && stagnationWindowStarted) {
      const changeRatio = textChangeRatio(previousEvaluated, current);
      if (changeRatio <= args.config.userInput.iterationPolicy.stagnationChangeThreshold) {
        const stored = await createStageTextAttemptFile(args.stageDir, current);
        args.manifest.stageRuns[args.stageId] = args.manifest.stageRuns[args.stageId] ?? { stageId: args.stageId, passes: [] };
        args.manifest.stageRuns[args.stageId]?.passes.push({ pass, artifactPath: stored.activePath, score, delta: 0, notes: `Early stop: text change ratio ${changeRatio.toFixed(4)} <= threshold ${args.config.userInput.iterationPolicy.stagnationChangeThreshold.toFixed(4)}.`, createdAt: new Date().toISOString() });
        args.manifest.activePassPointers[args.stageId] = pass;
        setCheckpoint(args.manifest, args.checkpointId, "complete", pass);
        await saveManifest(args.paths.manifestPath, args.manifest);
        emitProgress(args.progressReporter, step, { done: pass, total: pass, state: "complete", message: `${args.stageId} stopped at pass ${pass}: negligible text change.`, checkpointId: args.checkpointId, checkpointPath: stored.activePath, checkpointUrl: toFileUrl(stored.activePath) });
        return current;
      }
    }
    emitProgress(args.progressReporter, step, { done: pass - 1, total: Math.max(pass, 1), state: "in_progress", message: `Running ${args.stageId} pass ${pass}...`, checkpointId: args.checkpointId });
    if (process.env.NOVELWRITER_DEBUG === "1") {
      await appendEvent(args.paths.projectDir, {
        ts: new Date().toISOString(),
        level: "info",
        event: "stage_pass_start",
        details: { stageId: args.stageId, pass, checkpointId: args.checkpointId, hasCurrent: Boolean(current) },
      });
    }
    setCheckpoint(args.manifest, args.checkpointId, "in_progress", pass);
    await saveManifest(args.paths.manifestPath, args.manifest);

    if (!initialPrompt) {
      initialPrompt = await args.promptBuilder();
    }
    if (!current) {
      const firstPrompt = initialPrompt;
      if (process.env.NOVELWRITER_DEBUG === "1") {
        await appendEvent(args.paths.projectDir, { ts: new Date().toISOString(), level: "info", event: "stage_call_generate_start", details: { stageId: args.stageId, pass, promptChars: firstPrompt.length } });
      }
      const generated = await withRetry(args.config.userInput.retryPolicy, async () => args.llmClient.generateText({ stage: `${args.stageId}:generate:${pass}`, model, system, prompt: firstPrompt }));
      current = generated.text.trim();
      // Persist a crash-safe draft immediately so stage folders are never empty
      // if later critic/reviser calls fail in this pass.
      await writeTextAtomic(activePath, current);
      if (process.env.NOVELWRITER_DEBUG === "1") {
        await appendEvent(args.paths.projectDir, { ts: new Date().toISOString(), level: "info", event: "stage_call_generate_done", details: { stageId: args.stageId, pass, outputChars: current.length } });
      }
    }
    previousEvaluated = current;

    if (process.env.NOVELWRITER_DEBUG === "1") {
      await appendEvent(args.paths.projectDir, { ts: new Date().toISOString(), level: "info", event: "stage_call_critic_start", details: { stageId: args.stageId, pass, inputChars: current.length } });
    }
    const critique = await withRetry(args.config.userInput.retryPolicy, async () => args.llmClient.generateJson({ stage: `${args.stageId}:critic:${pass}`, model, system, prompt: buildCriticPrompt(args.stageId, current), schema: CRITIC_SCHEMA }));
    if (process.env.NOVELWRITER_DEBUG === "1") {
      await appendEvent(args.paths.projectDir, { ts: new Date().toISOString(), level: "info", event: "stage_call_critic_done", details: { stageId: args.stageId, pass, score: critique.object.score } });
    }
    const prevScore = score;
    score = critique.object.score;
    const delta = Math.max(0, score - prevScore);
    deltas.push(delta);
    premiseRevisionNotes = critique.object.notes;

    const stored = await createStageTextAttemptFile(args.stageDir, current);
    args.manifest.stageRuns[args.stageId] = args.manifest.stageRuns[args.stageId] ?? { stageId: args.stageId, passes: [] };
    args.manifest.stageRuns[args.stageId]?.passes.push({ pass, artifactPath: stored.activePath, score, delta, notes: critique.object.notes, createdAt: new Date().toISOString() });
    args.manifest.activePassPointers[args.stageId] = pass;
    await saveManifest(args.paths.manifestPath, args.manifest);

    const minPassesMet = pass >= args.config.userInput.iterationPolicy.minPassesPerStage;
    const maxPassesReached = pass >= args.config.userInput.iterationPolicy.maxPassesPerStage;
    const converged = hasConverged(deltas, args.config.userInput.iterationPolicy.convergenceWindow, args.config.userInput.iterationPolicy.deltaThreshold);
    const qualityMet = score >= args.config.userInput.iterationPolicy.qualityFloor;
    if ((minPassesMet && converged && qualityMet) || maxPassesReached) {
      setCheckpoint(args.manifest, args.checkpointId, "complete", pass);
      await saveManifest(args.paths.manifestPath, args.manifest);
      const reason = maxPassesReached && !(minPassesMet && converged && qualityMet) ? "hit max passes" : "converged";
      emitProgress(args.progressReporter, step, { done: pass, total: pass, state: "complete", message: `${args.stageId} ${reason} at pass ${pass}.`, checkpointId: args.checkpointId, checkpointPath: stored.activePath, checkpointUrl: toFileUrl(stored.activePath) });
      return current;
    }

    if (process.env.NOVELWRITER_DEBUG === "1") {
      await appendEvent(args.paths.projectDir, { ts: new Date().toISOString(), level: "info", event: "stage_call_reviser_start", details: { stageId: args.stageId, pass } });
    }
    if (args.stageId === "premise_expansion") {
      // Avoid "Chinese whisper" drift: regenerate from source premise + latest critique,
      // instead of repeatedly revising prior expanded drafts.
      const regeneratePrompt = [
        initialPrompt,
        "Refinement notes from critic (apply concretely while preserving source premise intent):",
        premiseRevisionNotes,
        "Rewrite the full brief from scratch with the exact required sections.",
      ].join("\n\n");
      const revised = await withRetry(args.config.userInput.retryPolicy, async () => args.llmClient.generateText({ stage: `${args.stageId}:reviser:${pass}`, model, system, prompt: regeneratePrompt }));
      current = revised.text.trim();
    } else {
      const revised = await withRetry(args.config.userInput.retryPolicy, async () => args.llmClient.generateText({ stage: `${args.stageId}:reviser:${pass}`, model, system, prompt: buildReviserPrompt(args.stageId, current, critique.object.notes) }));
      current = revised.text.trim();
    }
    if (process.env.NOVELWRITER_DEBUG === "1") {
      await appendEvent(args.paths.projectDir, { ts: new Date().toISOString(), level: "info", event: "stage_call_reviser_done", details: { stageId: args.stageId, pass, outputChars: current.length } });
    }

    const nextStage = STAGE_IDS[Math.min(STAGE_IDS.indexOf(args.stageId) + 1, STAGE_IDS.length - 1)] as StageId;
    const rationale = await plannerRationale(args.llmClient, system, model, args.stageId, pass, score, delta, nextStage);
    args.manifest.plannerDecisions.push({ stageId: args.stageId, nextStageId: nextStage, rationale, createdAt: new Date().toISOString() });
    await saveManifest(args.paths.manifestPath, args.manifest);
  }
}

async function readProjectConfig(configPath: string): Promise<AppConfig> {
  const source = await readFile(configPath, "utf-8");
  return AppConfigSchema.parse(YAML.load(source));
}

async function nextAvailableProjectId(artifactsRootAbs: string, desiredProjectId: string, currentProjectId: string): Promise<string> {
  if (desiredProjectId === currentProjectId) return currentProjectId;
  let candidate = desiredProjectId;
  let suffix = 2;
  while (true) {
    try {
      await access(getProjectPaths(artifactsRootAbs, candidate).projectDir);
      candidate = `${desiredProjectId}-${suffix++}`;
    } catch {
      return candidate;
    }
  }
}

export interface RunProjectOptions { config: AppConfig; deps?: PipelineDeps; progressReporter?: PipelineProgressReporter; modelOverride?: string; projectId?: string }

export async function createAndRunProject(options: RunProjectOptions): Promise<{ projectId: string; projectDir: string }> {
  const now = options.deps?.now ?? (() => new Date());
  const projectId = options.projectId ?? createProjectId(options.config.userInput.bookTitle, now());
  const artifactsRoot = normalizeArtifactsRoot(options.config.runtime.artifactsRoot);
  const paths = getProjectPaths(artifactsRoot, projectId);
  const retitleProjectIdFromOutline = !options.projectId && !options.config.userInput.bookTitle.trim();

  await initProjectDirs(paths);
  await saveConfigAsYaml(paths.projectYamlPath, options.config);
  await writeJsonAtomic(paths.inputPath, options.config.userInput);
  const manifest = buildInitialManifest({ projectId, userInput: options.config.userInput, runtime: options.config.runtime });
  await saveManifest(paths.manifestPath, manifest);

  const finalProjectId = await runPipeline({ artifactsRoot, projectId, retitleProjectIdFromOutline, ...(options.deps ? { deps: options.deps } : {}), ...(options.progressReporter ? { progressReporter: options.progressReporter } : {}), ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}) });
  return { projectId: finalProjectId, projectDir: getProjectPaths(artifactsRoot, finalProjectId).projectDir };
}

function openRouterSessionIdForProject(projectId: string): string {
  return `book-${projectId}`;
}

interface RunPipelineArgs {
  artifactsRoot: string;
  projectId: string;
  retitleProjectIdFromOutline?: boolean;
  deps?: PipelineDeps;
  progressReporter?: PipelineProgressReporter;
  modelOverride?: string;
  force?: { outline?: boolean; blocksChapter?: number; chapter?: number; block?: { chapterNumber: number; blockNumber: number } };
}

export async function runPipeline(args: RunPipelineArgs): Promise<string> {
  const artifactsRoot = normalizeArtifactsRoot(args.artifactsRoot);
  let projectId = args.projectId;
  let paths = getProjectPaths(artifactsRoot, projectId);
  const debugLogPath = path.join(paths.projectDir, "logs", "debug.jsonl");
  if (process.env.NOVELWRITER_DEBUG === "1") {
    process.env.NOVELWRITER_DEBUG_LOG_PATH = debugLogPath;
    await appendEvent(paths.projectDir, { ts: new Date().toISOString(), level: "info", event: "debug_enabled", details: { debugLogPath } });
  }
  const config = await readProjectConfig(paths.projectYamlPath);
  const manifest = await loadManifest(paths.manifestPath);
  await ensureProviderEnv(config.userInput.provider);
  const baseLLMClient = args.deps?.llmClient ?? (await createLLMClient(
    config.userInput.provider,
    { sessionId: openRouterSessionIdForProject(projectId), ...(process.env.NOVELWRITER_DEBUG === "1" ? { debugLogPath } : {}) },
  ));
  let llmClient = wrapLLMClientWithProgressActivity({
    llmClient: wrapLLMClientWithUsageLogging({
      llmClient: baseLLMClient,
      provider: config.userInput.provider.type,
      requestPath: paths.usageRequestPath,
      summaryPath: paths.usageSummaryPath,
    }),
    ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}),
  });

  const touchProjectUpdatedAt = async (): Promise<void> => {
    await saveManifest(paths.manifestPath, manifest);
  };

  try {
    const premise = await runIterativeTextStage({ stageId: "premise_expansion", stageDir: paths.premiseDir, checkpointId: checkpointIdForStage("premise_expansion"), promptBuilder: () => buildPremiseExpansionPrompt(config.userInput), config, paths, manifest, llmClient, ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}), ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}) });
    await touchProjectUpdatedAt();

    const summary = await runIterativeTextStage({ stageId: "story_summary", stageDir: paths.summaryDir, checkpointId: checkpointIdForStage("story_summary"), promptBuilder: () => buildSummaryPrompt(config.userInput, premise), config, paths, manifest, llmClient, ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}), ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}) });
    await touchProjectUpdatedAt();

    const outlineCheckpoint = checkpointIdForStage("chapter_outline");
    let outline;
    if (!args.force?.outline && getCheckpointStatus(manifest, outlineCheckpoint) === "complete") {
      const cachedOutline = await readJsonFile<unknown>(path.join(paths.outlineDir, "active.json"));
      outline = normalizeOutlineCandidate(cachedOutline, config.userInput.chapterCount, config.userInput.targetWordCount);
    } else {
    const system = buildSystemPrompt(config.userInput.systemPromptTemplate);
    const model = resolveModel(config, "outline", args.modelOverride);
    const outlinePrompt = buildOutlinePrompt(config.userInput, summary);
    const outlineText = await withRetry(config.userInput.retryPolicy, async () => llmClient.generateText({ stage: "chapter_outline", model, system, prompt: outlinePrompt }));
    let parsedOutline: unknown;
    try {
      parsedOutline = parseJsonFromText(outlineText.text);
    } catch (error) {
      throw new Error(`Failed to parse chapter_outline JSON: ${(error as Error).message}`);
    }
    const normalizedOutline = normalizeOutlineCandidate(parsedOutline, config.userInput.chapterCount, config.userInput.targetWordCount);
    const stored = await createStageAttemptFile(paths.outlineDir, normalizedOutline);
    setCheckpoint(manifest, outlineCheckpoint, "complete", stored.attempt);
    await saveManifest(paths.manifestPath, manifest);
    outline = normalizedOutline;
    emitProgress(args.progressReporter, PIPELINE_STEPS.chapter_outline, { done: 1, total: 1, state: "complete", message: "Chapter outline complete.", checkpointId: outlineCheckpoint, checkpointPath: stored.activePath, checkpointUrl: toFileUrl(stored.activePath) });
    }
    await touchProjectUpdatedAt();

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
        llmClient = wrapLLMClientWithProgressActivity({
          llmClient: wrapLLMClientWithUsageLogging({
            llmClient: baseLLMClient,
            provider: config.userInput.provider.type,
            requestPath: paths.usageRequestPath,
            summaryPath: paths.usageSummaryPath,
          }),
          ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}),
        });
      }
    }
    manifest.projectId = projectId;
    manifest.bookTitle = resolvedBookTitle;
    await saveConfigAsYaml(paths.projectYamlPath, config);
    await writeJsonAtomic(paths.inputPath, config.userInput);
    await saveManifest(paths.manifestPath, manifest);
    }

    await seedStoryBible(paths, outline);

    let previousTail = "";
    const chapterTexts: string[] = [];
    for (const chapter of outline.chapters) {
    const chapterCheckpoint = checkpointIdForChapter(chapter.chapterNumber);
    const chDir = path.join(paths.chapterDir, chapterKey(chapter.chapterNumber));
    const activeChapterPath = path.join(chDir, "chapter.active.md");
    if (!args.force?.chapter && getCheckpointStatus(manifest, chapterCheckpoint) === "complete") {
      const existing = await readFile(activeChapterPath, "utf-8");
      chapterTexts.push(existing);
      previousTail = getTailByWords(existing, config.runtime.tailWindowWords);
      continue;
    }

    let pass = 0;
    let current = "";
    let previousEvaluated = "";
    let score = 0;
    const deltas: number[] = [];
    const system = buildSystemPrompt(config.userInput.systemPromptTemplate);
    const model = resolveModel(config, "chapter", args.modelOverride);

    const blocksPrompt = buildStoryBlocksPrompt({
      outline,
      chapterNumber: chapter.chapterNumber,
      chapterSummary: chapter.summary,
      minBlocks: config.userInput.blockPolicy.minBlocksPerChapter,
      maxBlocks: config.userInput.blockPolicy.maxBlocksPerChapter,
    });
    const blocksText = await withRetry(config.userInput.retryPolicy, async () => llmClient.generateText({
      stage: `chapter_loop:${chapter.chapterNumber}:blocks`,
      model,
      system,
      prompt: blocksPrompt,
    }));
    let parsedBlocks: unknown;
    try {
      parsedBlocks = parseJsonFromText(blocksText.text);
    } catch (error) {
      throw new Error(`Failed to parse blocks JSON for chapter ${chapter.chapterNumber}: ${(error as Error).message}`);
    }
    const normalizedBlocks = normalizeStoryBlocksCandidate(
      parsedBlocks,
      chapter.chapterNumber,
      chapter.title,
      config.userInput.blockPolicy.minBlocksPerChapter,
      config.userInput.blockPolicy.maxBlocksPerChapter,
      chapter.targetWordsGuideline,
    );

    let rollingSummary = RollingSummarySchema.parse({
      plotState: chapter.summary,
      characterState: "Characters poised to execute chapter goals.",
      openLoops: [],
      styleConstraints: [],
    });
    let storyBibleState = await loadStoryBibleState(paths);

    while (true) {
      pass += 1;
      const minPassesMetForStagnation = pass >= config.userInput.iterationPolicy.minPassesPerStage;
      const stagnationWindowStarted = pass >= config.userInput.iterationPolicy.stagnationPassStart;
      if (previousEvaluated && minPassesMetForStagnation && stagnationWindowStarted) {
        const changeRatio = textChangeRatio(previousEvaluated, current);
        if (changeRatio <= config.userInput.iterationPolicy.stagnationChangeThreshold) {
          const markdown = buildChapterMarkdown(chapter.chapterNumber, chapter.title, current);
          const stored = await createChapterPassFile(paths.chapterDir, chapter.chapterNumber, pass, markdown);
          manifest.stageRuns[`chapter_loop:${chapter.chapterNumber}`] = manifest.stageRuns[`chapter_loop:${chapter.chapterNumber}`] ?? { stageId: `chapter_loop:${chapter.chapterNumber}`, passes: [] };
          manifest.stageRuns[`chapter_loop:${chapter.chapterNumber}`]?.passes.push({ pass, artifactPath: stored.activePath, score, delta: 0, notes: `Early stop: text change ratio ${changeRatio.toFixed(4)} <= threshold ${config.userInput.iterationPolicy.stagnationChangeThreshold.toFixed(4)}.`, createdAt: new Date().toISOString() });
          manifest.activePassPointers[`chapter_loop:${chapter.chapterNumber}`] = pass;
          setCheckpoint(manifest, chapterCheckpoint, "complete", pass);
          await saveManifest(paths.manifestPath, manifest);
          chapterTexts.push(markdown);
          previousTail = getTailByWords(markdown, config.runtime.tailWindowWords);
          break;
        }
      }
      if (!current) {
        const blockDrafts: string[] = [];
        for (const block of normalizedBlocks.blocks) {
          const request = await withRetry(config.userInput.retryPolicy, async () => llmClient.generateJson({
            stage: `chapter_loop:${chapter.chapterNumber}:context_request:${pass}:block:${block.blockNumber}`,
            model,
            system,
            prompt: buildContextRequestPrompt({
              chapterNumber: chapter.chapterNumber,
              chapterTitle: chapter.title,
              blockNumber: block.blockNumber,
              blockGoal: block.goal,
              blockEvents: block.events,
              rollingSummary: formatRollingSummary(rollingSummary),
            }),
            schema: ContextRequestSchema,
          }));

          const resolved = await resolveContext(paths, ContextRequestSchema.parse(request.object));
          const resolvedContextText = [
            `Character context: ${resolved.characterContext.join(" | ") || "None"}`,
            `Event context: ${resolved.eventContext.join(" | ") || "None"}`,
            `World context: ${resolved.worldContext.join(" | ") || "None"}`,
            `Continuity answers: ${resolved.continuityAnswers.join(" | ") || "None"}`,
            `Carry-forward constraints: ${resolved.carryForwardConstraints.join(" | ") || "None"}`,
          ].join("\n");

          const draft = await withRetry(config.userInput.retryPolicy, async () => llmClient.generateText({
            stage: `chapter_loop:${chapter.chapterNumber}:block_draft:${pass}:block:${block.blockNumber}`,
            model,
            system,
            prompt: buildBlockDraftPrompt({
              outline,
              chapterNumber: chapter.chapterNumber,
              chapterTitle: chapter.title,
              blockNumber: block.blockNumber,
              blockGoal: block.goal,
              blockEvents: block.events,
              blockCharacters: block.characters,
              targetWordsGuideline: block.targetWordsGuideline,
              previousChapterTail: previousTail,
              rollingSummary: formatRollingSummary(rollingSummary),
              resolvedContext: resolvedContextText,
            }),
          }));

          const memory = await withRetry(config.userInput.retryPolicy, async () => llmClient.generateJson({
            stage: `chapter_loop:${chapter.chapterNumber}:memory_update:${pass}:block:${block.blockNumber}`,
            model: resolveModel(config, "memory", args.modelOverride),
            system,
            prompt: buildMemoryUpdatePrompt({
              chapterNumber: chapter.chapterNumber,
              blockNumber: block.blockNumber,
              previousSummary: formatRollingSummary(rollingSummary),
              blockText: draft.text.trim(),
            }),
            schema: RollingSummarySchema,
          }));

          rollingSummary = RollingSummarySchema.parse(memory.object);

          const storyBibleUpdate = await withRetry(config.userInput.retryPolicy, async () => llmClient.generateJson({
            stage: `chapter_loop:${chapter.chapterNumber}:story_bible_update:${pass}:block:${block.blockNumber}`,
            model: resolveModel(config, "memory", args.modelOverride),
            system,
            prompt: buildStoryBibleUpdatePrompt({
              chapterNumber: chapter.chapterNumber,
              blockNumber: block.blockNumber,
              blockText: draft.text.trim(),
              currentBible: formatStoryBibleState(storyBibleState),
            }),
            schema: StoryBibleStateSchema,
          }));
          storyBibleState = StoryBibleStateSchema.parse(storyBibleUpdate.object);
          await saveStoryBibleState(paths, outline, storyBibleState);

          blockDrafts.push(draft.text.trim());
        }
        current = blockDrafts.join("\n\n");
      }
      previousEvaluated = current;

      const critique = await llmClient.generateJson({ stage: `chapter_loop:${chapter.chapterNumber}:critic:${pass}`, model, system, prompt: buildCriticPrompt("chapter_loop", current), schema: CRITIC_SCHEMA });
      const delta = Math.max(0, critique.object.score - score);
      score = critique.object.score;
      deltas.push(delta);
      const markdown = buildChapterMarkdown(chapter.chapterNumber, chapter.title, current);
      const stored = await createChapterPassFile(paths.chapterDir, chapter.chapterNumber, pass, markdown);

      manifest.stageRuns[`chapter_loop:${chapter.chapterNumber}`] = manifest.stageRuns[`chapter_loop:${chapter.chapterNumber}`] ?? { stageId: `chapter_loop:${chapter.chapterNumber}`, passes: [] };
      manifest.stageRuns[`chapter_loop:${chapter.chapterNumber}`]?.passes.push({ pass, artifactPath: stored.activePath, score, delta, notes: critique.object.notes, createdAt: new Date().toISOString() });
      manifest.activePassPointers[`chapter_loop:${chapter.chapterNumber}`] = pass;
      await saveManifest(paths.manifestPath, manifest);

      const minMet = pass >= config.userInput.iterationPolicy.minPassesPerStage;
      const maxPassesReached = pass >= config.userInput.iterationPolicy.maxPassesPerStage;
      const converged = hasConverged(deltas, config.userInput.iterationPolicy.convergenceWindow, config.userInput.iterationPolicy.deltaThreshold);
      const qualityMet = score >= config.userInput.iterationPolicy.qualityFloor;
      if ((minMet && converged && qualityMet) || maxPassesReached) {
        setCheckpoint(manifest, chapterCheckpoint, "complete", pass);
        await saveManifest(paths.manifestPath, manifest);
        chapterTexts.push(markdown);
        previousTail = getTailByWords(markdown, config.runtime.tailWindowWords);
        break;
      }

      const revised = await llmClient.generateText({ stage: `chapter_loop:${chapter.chapterNumber}:reviser:${pass}`, model, system, prompt: buildReviserPrompt("chapter_loop", current, critique.object.notes) });
      current = revised.text.trim();
    }
    }

    emitProgress(args.progressReporter, PIPELINE_STEPS.chapter_loop, { done: chapterTexts.length, total: outline.chapters.length, state: "complete", message: "Chapter loop complete." });
    await touchProjectUpdatedAt();

    const revisedManuscript = await runIterativeTextStage({ stageId: "global_revision", stageDir: paths.globalRevisionDir, checkpointId: checkpointIdForStage("global_revision"), promptBuilder: () => buildGlobalRevisionPrompt({ outline, chapters: chapterTexts }), config, paths, manifest, llmClient, ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}), ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}) });
    await touchProjectUpdatedAt();

    await writeTextAtomic(path.join(paths.globalRevisionDir, "manuscript.active.md"), revisedManuscript);
    await exportProjectEpub({ artifactsRoot, projectId, ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}) });
    await touchProjectUpdatedAt();

    await appendEvent(paths.projectDir, { ts: new Date().toISOString(), level: "info", event: "pipeline_complete", details: { projectId } });
    return projectId;
  } catch (error) {
    const inProgress = Object.entries(manifest.checkpoints)
      .filter(([, checkpoint]) => checkpoint.status === "in_progress")
      .sort((a, b) => (b[1].updatedAt ?? "").localeCompare(a[1].updatedAt ?? ""))[0];
    const failedCheckpointId = inProgress?.[0];
    const failedAttempt = inProgress?.[1]?.attempt ?? 0;
    if (failedCheckpointId) {
      setCheckpoint(manifest, failedCheckpointId, "failed", failedAttempt, toErrorMessage(error));
      await saveManifest(paths.manifestPath, manifest);
    }

    const failedStepIdRaw = failedCheckpointId?.replace(/^stage:/, "").split(":")[0];
    const failedStepId = failedStepIdRaw && failedStepIdRaw in PIPELINE_STEPS ? (failedStepIdRaw as PipelineStepId) : undefined;
    if (failedStepId) {
      const stepMeta = PIPELINE_STEPS[failedStepId];
      emitProgress(args.progressReporter, stepMeta, {
        done: failedAttempt,
        total: Math.max(failedAttempt, 1),
        state: "failed",
        message: `${stepMeta.label} failed: ${toErrorMessage(error)}`,
        ...(failedCheckpointId ? { checkpointId: failedCheckpointId } : {}),
      });
    }

    await appendFailure(paths.projectDir, {
      ts: new Date().toISOString(),
      error: toErrorMessage(error),
      ...(failedStepId ? { stepId: failedStepId } : {}),
      ...(failedCheckpointId ? { checkpointId: failedCheckpointId } : {}),
      details: { projectId },
    });
    await appendEvent(paths.projectDir, {
      ts: new Date().toISOString(),
      level: "error",
      event: "pipeline_failed",
      details: {
        projectId,
        ...(failedStepId ? { stepId: failedStepId } : {}),
        ...(failedCheckpointId ? { checkpointId: failedCheckpointId } : {}),
        error: toErrorMessage(error),
      },
    });

    throw new PipelineRunError(toErrorMessage(error), {
      projectId,
      projectDir: paths.projectDir,
      ...(failedStepId ? { stepId: failedStepId } : {}),
      ...(failedCheckpointId ? { checkpointId: failedCheckpointId } : {}),
    });
  }
}

export async function resumeProject(args: { artifactsRoot: string; projectId?: string; deps?: PipelineDeps; progressReporter?: PipelineProgressReporter; modelOverride?: string }): Promise<string> {
  const resolvedProjectId = args.projectId ?? (await findMostRecentIncompleteProjectId(args.artifactsRoot));
  if (!resolvedProjectId) throw new Error("No incomplete projects found. Pass --project-id to resume a specific project.");
  await runPipeline({ ...args, projectId: resolvedProjectId });
  return resolvedProjectId;
}

function setPending(manifest: ProjectManifest, id: string): void {
  const existing = manifest.checkpoints[id];
  manifest.checkpoints[id] = { status: "pending", attempt: existing?.attempt ?? 0, updatedAt: new Date().toISOString() };
}

function invalidateForTarget(manifest: ProjectManifest, target: "outline" | "blocks" | "chapter" | "block", chapter?: number): void {
  if (target === "outline") {
    for (const id of Object.keys(manifest.checkpoints)) setPending(manifest, id);
    return;
  }
  if (target === "blocks") {
    if (chapter) setPending(manifest, checkpointIdForChapter(chapter));
    else for (const id of Object.keys(manifest.checkpoints)) if (id.startsWith("stage:chapter_loop") || id.startsWith("stage:global_revision")) setPending(manifest, id);
    setPending(manifest, checkpointIdForExportEpub());
    return;
  }
  if (target === "chapter") {
    if (!chapter) throw new Error("chapter is required for target=chapter");
    setPending(manifest, checkpointIdForChapter(chapter));
    setPending(manifest, checkpointIdForExportEpub());
    return;
  }
  if (!chapter) throw new Error("chapter is required for target=block");
  setPending(manifest, checkpointIdForChapter(chapter));
  setPending(manifest, checkpointIdForExportEpub());
}

export async function regenerateProject(args: { artifactsRoot: string; projectId: string; target: "outline" | "blocks" | "chapter" | "block"; chapter?: number; block?: number; deps?: PipelineDeps; progressReporter?: PipelineProgressReporter; modelOverride?: string }): Promise<void> {
  const artifactsRoot = normalizeArtifactsRoot(args.artifactsRoot);
  const paths = getProjectPaths(artifactsRoot, args.projectId);
  const manifest = await loadManifest(paths.manifestPath);
  invalidateForTarget(manifest, args.target, args.chapter);
  await saveManifest(paths.manifestPath, manifest);
  await runPipeline({ artifactsRoot, projectId: args.projectId, ...(args.deps ? { deps: args.deps } : {}), ...(args.progressReporter ? { progressReporter: args.progressReporter } : {}), ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}), force: { ...(args.target === "outline" ? { outline: true } : {}), ...(args.target === "chapter" && typeof args.chapter === "number" ? { chapter: args.chapter } : {}) } });
}

export interface ExportProgressStep { stepIndex: number; stepCount: number; stepLabel?: string }
export async function exportProjectEpub(args: { artifactsRoot: string; projectId: string; progressReporter?: PipelineProgressReporter; progressStep?: ExportProgressStep }): Promise<string> {
  const artifactsRoot = normalizeArtifactsRoot(args.artifactsRoot);
  const paths = getProjectPaths(artifactsRoot, args.projectId);
  const manifest = await loadManifest(paths.manifestPath);
  const exportStepMeta: PipelineStepMeta = { id: PIPELINE_STEPS.export_epub.id, label: args.progressStep?.stepLabel ?? PIPELINE_STEPS.export_epub.label, index: args.progressStep?.stepIndex ?? PIPELINE_STEPS.export_epub.index, count: args.progressStep?.stepCount ?? PIPELINE_STEPS.export_epub.count };
  const checkpointId = checkpointIdForExportEpub();

  emitProgress(args.progressReporter, exportStepMeta, { done: 0, total: 1, state: "in_progress", message: "Packaging EPUB export...", checkpointId });

  const epubPath = await exportStyledEpub({
    projectDir: paths.projectDir,
    exportDir: paths.exportDir,
    slug: slugify(manifest.bookTitle) || "book",
    metadata: { title: manifest.bookTitle, author: manifest.author, language: manifest.language, description: `Generated novel project ${manifest.projectId}` },
  });

  setCheckpoint(manifest, checkpointId, "complete", 1);
  await saveManifest(paths.manifestPath, manifest);
  emitProgress(args.progressReporter, exportStepMeta, { done: 1, total: 1, state: "complete", message: "EPUB export complete.", checkpointId, checkpointPath: epubPath, checkpointUrl: toFileUrl(epubPath) });
  return epubPath;
}

export interface ProjectStatus { projectId: string; bookTitle: string; createdAt: string; updatedAt: string; checkpointCounts: Record<CheckpointStatus, number> }
export async function getProjectStatus(args: { artifactsRoot: string; projectId: string }): Promise<ProjectStatus> {
  const artifactsRoot = normalizeArtifactsRoot(args.artifactsRoot);
  const paths = getProjectPaths(artifactsRoot, args.projectId);
  const manifest = await loadManifest(paths.manifestPath);
  const counts: Record<CheckpointStatus, number> = { pending: 0, in_progress: 0, complete: 0, failed: 0 };
  for (const checkpoint of Object.values(manifest.checkpoints)) counts[checkpoint.status] += 1;
  return { projectId: manifest.projectId, bookTitle: manifest.bookTitle, createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, checkpointCounts: counts };
}

export interface ResumeProjectInfo {
  projectId: string;
  folderName: string;
  bookTitle: string;
  author: string;
  language: string;
  provider: "lmstudio" | "openrouter";
  model: string;
  updatedAt: string;
}

export async function resolveResumeProjectInfo(args: { artifactsRoot: string; projectId?: string }): Promise<ResumeProjectInfo> {
  const artifactsRoot = normalizeArtifactsRoot(args.artifactsRoot);
  const resolvedProjectId = args.projectId ?? (await findMostRecentIncompleteProjectId(artifactsRoot));
  if (!resolvedProjectId) throw new Error("No incomplete projects found. Pass --project-id to resume a specific project.");
  const paths = getProjectPaths(artifactsRoot, resolvedProjectId);
  const config = await readProjectConfig(paths.projectYamlPath);
  const manifest = await loadManifest(paths.manifestPath);
  return {
    projectId: manifest.projectId,
    folderName: path.basename(paths.projectDir),
    bookTitle: manifest.bookTitle,
    author: manifest.author,
    language: manifest.language,
    provider: config.userInput.provider.type,
    model: config.userInput.modelConfig.defaultModel,
    updatedAt: manifest.updatedAt,
  };
}

export async function listProjects(artifactsRoot: string): Promise<string[]> {
  const root = normalizeArtifactsRoot(artifactsRoot);
  await ensureDir(root);
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
}

function isIncompleteProject(manifest: ProjectManifest): boolean {
  const checkpoints = Object.values(manifest.checkpoints);
  if (checkpoints.length === 0) return true;
  return checkpoints.some((checkpoint) => checkpoint.status !== "complete");
}

export async function findMostRecentIncompleteProjectId(artifactsRoot: string): Promise<string | null> {
  const root = normalizeArtifactsRoot(artifactsRoot);
  const projectIds = await listProjects(root);
  const candidates = await Promise.all(projectIds.map(async (projectId) => {
    const paths = getProjectPaths(root, projectId);
    try {
      const manifest = await loadManifest(paths.manifestPath);
      if (!isIncompleteProject(manifest)) return null;
      const updatedAtMs = Date.parse(manifest.updatedAt);
      return { projectId, updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : Number.NEGATIVE_INFINITY };
    } catch { return null; }
  }));
  const mostRecent = candidates.filter((c): c is { projectId: string; updatedAtMs: number } => c !== null).sort((a, b) => (b.updatedAtMs - a.updatedAtMs) || b.projectId.localeCompare(a.projectId))[0];
  return mostRecent?.projectId ?? null;
}

export function buildDefaultRetryPolicy(): RetryPolicy {
  return { maxRetries: 3, baseDelayMs: 750, maxDelayMs: 8_000, jitterRatio: 0.15 };
}
