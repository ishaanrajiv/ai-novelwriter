import { z } from "zod";

export const SystemPromptTemplateSchema = z.object({
  tone: z.string().min(1),
  pov: z.string().min(1),
  tense: z.string().min(1),
  style: z.string().min(1),
  constraints: z.string().min(1),
  custom: z.string().default(""),
});

export const ModelConfigSchema = z.object({
  defaultModel: z.string().min(1),
  outlineModel: z.string().optional(),
  blocksModel: z.string().optional(),
  chapterModel: z.string().optional(),
  memoryModel: z.string().optional(),
});

export const BlockPolicySchema = z.object({
  minBlocksPerChapter: z.number().int().positive().default(3),
  maxBlocksPerChapter: z.number().int().positive().default(8),
});

export const RetryPolicySchema = z.object({
  maxRetries: z.number().int().min(0).default(3),
  baseDelayMs: z.number().int().positive().default(750),
  maxDelayMs: z.number().int().positive().default(8_000),
  jitterRatio: z.number().min(0).max(1).default(0.15),
});

export const UserInputSchema = z.object({
  bookTitle: z.string().default(""),
  author: z.string().min(1),
  language: z.string().min(1).default("en"),
  premise: z.string().min(1),
  chapterCount: z.number().int().min(1),
  targetWordCount: z.number().int().min(1000),
  systemPromptTemplate: SystemPromptTemplateSchema,
  modelConfig: ModelConfigSchema,
  blockPolicy: BlockPolicySchema,
  retryPolicy: RetryPolicySchema,
});

export const RuntimeConfigSchema = z.object({
  artifactsRoot: z.string().default(".artifacts/novels"),
  tailWindowWords: z.number().int().min(200).default(1200),
});

export const AppConfigSchema = z.object({
  userInput: UserInputSchema,
  runtime: RuntimeConfigSchema.default({}),
});

export const OutlineChapterSchema = z.object({
  chapterNumber: z.number().int().positive(),
  title: z.string().min(1),
  summary: z.string().min(1),
  targetWordsGuideline: z.number().int().min(1),
});

export const OutlineResultSchema = z.object({
  bookTitle: z.string().min(1),
  globalStoryArc: z.string().min(1),
  chapters: z.array(OutlineChapterSchema).min(1),
});

export const StoryBlockSchema = z.object({
  blockNumber: z.number().int().positive(),
  goal: z.string().min(1),
  events: z.array(z.string().min(1)).min(1),
  characters: z.array(z.string().min(1)).default([]),
  continuityNotes: z.array(z.string().min(1)).default([]),
  targetWordsGuideline: z.number().int().min(1),
});

export const StoryBlocksResultSchema = z.object({
  chapterNumber: z.number().int().positive(),
  chapterTitle: z.string().min(1),
  blocks: z.array(StoryBlockSchema).min(1),
});

export const RollingSummarySchema = z.object({
  plotState: z.string().min(1),
  characterState: z.string().min(1),
  openLoops: z.array(z.string().min(1)).default([]),
  styleConstraints: z.array(z.string().min(1)).default([]),
});

export const ChapterBlockDraftSchema = z.object({
  blockNumber: z.number().int().positive(),
  text: z.string().min(1),
  updatedSummary: RollingSummarySchema,
});

export const CheckpointStatusSchema = z.enum(["pending", "in_progress", "complete", "failed"]);

export const CheckpointSchema = z.object({
  status: CheckpointStatusSchema,
  updatedAt: z.string().min(1),
  attempt: z.number().int().min(0).default(0),
  error: z.string().optional(),
});

export const ManifestActivePointersSchema = z.object({
  outlineAttempt: z.number().int().min(0).default(0),
  blocksAttempts: z.record(z.string(), z.number().int().min(0)).default({}),
  chapterAttempts: z.record(z.string(), z.number().int().min(0)).default({}),
  blockAttempts: z.record(z.string(), z.record(z.string(), z.number().int().min(0))).default({}),
});

export const ProjectManifestSchema = z.object({
  projectId: z.string().min(1),
  bookTitle: z.string().min(1),
  author: z.string().min(1),
  language: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  checkpoints: z.record(z.string(), CheckpointSchema).default({}),
  activePointers: ManifestActivePointersSchema.default({}),
  runtime: RuntimeConfigSchema,
});

export type SystemPromptTemplate = z.infer<typeof SystemPromptTemplateSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type BlockPolicy = z.infer<typeof BlockPolicySchema>;
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type UserInput = z.infer<typeof UserInputSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type OutlineResult = z.infer<typeof OutlineResultSchema>;
export type StoryBlock = z.infer<typeof StoryBlockSchema>;
export type StoryBlocksResult = z.infer<typeof StoryBlocksResultSchema>;
export type RollingSummary = z.infer<typeof RollingSummarySchema>;
export type ChapterBlockDraft = z.infer<typeof ChapterBlockDraftSchema>;
export type CheckpointStatus = z.infer<typeof CheckpointStatusSchema>;
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
