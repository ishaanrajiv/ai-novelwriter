import { z } from "zod";

export const SystemPromptTemplateSchema = z.object({
  tone: z.string().min(1),
  pov: z.string().min(1),
  tense: z.string().min(1),
  style: z.string().min(1),
  constraints: z.string().min(1),
  custom: z.string().default(""),
});

export const ProviderConfigSchema = z.object({
  type: z.enum(["lmstudio", "openrouter"]).default("lmstudio"),
  lmstudio: z
    .object({
      baseUrl: z.string().url().default("http://127.0.0.1:1234/v1"),
      apiKeyEnv: z.string().min(1).default("LMSTUDIO_API_KEY"),
    })
    .default({}),
  openrouter: z
    .object({
      apiKeyEnv: z.string().min(1).default("OPENROUTER_API_KEY"),
      httpRefererEnv: z.string().min(1).default("OPENROUTER_HTTP_REFERER"),
      appNameEnv: z.string().min(1).default("OPENROUTER_APP_NAME"),
    })
    .default({}),
});

export const ModelConfigSchema = z.object({
  defaultModel: z.string().min(1),
  outlineModel: z.string().optional(),
  blocksModel: z.string().optional(),
  chapterModel: z.string().optional(),
  memoryModel: z.string().optional(),
});

export const IterationPolicySchema = z.object({
  minPassesPerStage: z.number().int().min(1).default(1),
  maxPassesPerStage: z.number().int().min(1).default(3),
  convergenceWindow: z.number().int().min(1).default(2),
  deltaThreshold: z.number().min(0).max(1).default(0.02),
  manualApprovalMode: z.boolean().default(false),
  qualityFloor: z.number().min(0).max(1).default(0.8),
}).refine((value) => value.maxPassesPerStage >= value.minPassesPerStage, {
  message: "maxPassesPerStage must be >= minPassesPerStage",
  path: ["maxPassesPerStage"],
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
  provider: ProviderConfigSchema.default({}),
  systemPromptTemplate: SystemPromptTemplateSchema,
  modelConfig: ModelConfigSchema,
  iterationPolicy: IterationPolicySchema.default({}),
  blockPolicy: BlockPolicySchema.default({}),
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

export const ContextRequestSchema = z.object({
  chapterNumber: z.number().int().positive(),
  blockNumber: z.number().int().positive(),
  neededCharacters: z.array(z.string().min(1)).default([]),
  neededEvents: z.array(z.string().min(1)).default([]),
  neededWorldRules: z.array(z.string().min(1)).default([]),
  continuityQuestions: z.array(z.string().min(1)).default([]),
});

export const ResolvedContextSchema = z.object({
  characterContext: z.array(z.string().min(1)).default([]),
  eventContext: z.array(z.string().min(1)).default([]),
  worldContext: z.array(z.string().min(1)).default([]),
  continuityAnswers: z.array(z.string().min(1)).default([]),
  carryForwardConstraints: z.array(z.string().min(1)).default([]),
});

export const StoryBibleStateSchema = z.object({
  characters: z.array(z.string().min(1)).default([]),
  events: z.array(z.string().min(1)).default([]),
  worldRules: z.array(z.string().min(1)).default([]),
  styleAnchors: z.array(z.string().min(1)).default([]),
});

export const StagePassSchema = z.object({
  pass: z.number().int().min(1),
  artifactPath: z.string().min(1),
  score: z.number().min(0).max(1),
  delta: z.number().min(0),
  notes: z.string().default(""),
  createdAt: z.string().min(1),
});

export const StageRunSchema = z.object({
  stageId: z.string().min(1),
  passes: z.array(StagePassSchema).default([]),
});

export const PlannerDecisionSchema = z.object({
  stageId: z.string().min(1),
  nextStageId: z.string().min(1),
  rationale: z.string().min(1),
  createdAt: z.string().min(1),
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
  stageRuns: z.record(z.string(), StageRunSchema).default({}),
  plannerDecisions: z.array(PlannerDecisionSchema).default([]),
  activePassPointers: z.record(z.string(), z.number().int().min(0)).default({}),
  runtime: RuntimeConfigSchema,
});

export type SystemPromptTemplate = z.infer<typeof SystemPromptTemplateSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type IterationPolicy = z.infer<typeof IterationPolicySchema>;
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
export type ContextRequest = z.infer<typeof ContextRequestSchema>;
export type ResolvedContext = z.infer<typeof ResolvedContextSchema>;
export type StoryBibleState = z.infer<typeof StoryBibleStateSchema>;
export type StagePass = z.infer<typeof StagePassSchema>;
export type StageRun = z.infer<typeof StageRunSchema>;
export type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;
export type CheckpointStatus = z.infer<typeof CheckpointStatusSchema>;
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
