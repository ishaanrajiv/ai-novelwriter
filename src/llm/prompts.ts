import type { OutlineResult, SystemPromptTemplate, UserInput } from "../types/index.js";

export const STAGE_IDS = [
  "premise_expansion",
  "story_summary",
  "chapter_outline",
  "chapter_loop",
  "global_revision",
  "export_epub",
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export function buildSystemPrompt(template: SystemPromptTemplate): string {
  return [
    "You are a professional fiction writer and developmental editor.",
    `Tone: ${template.tone}`,
    `POV: ${template.pov}`,
    `Tense: ${template.tense}`,
    `Style: ${template.style}`,
    `Constraints: ${template.constraints}`,
    template.custom ? `Custom guidance: ${template.custom}` : "",
    "Output should be coherent, consistent, and avoid contradictions.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPremiseExpansionPrompt(input: UserInput): string {
  return [
    `Premise: ${input.premise}`,
    `Target word count: ${input.targetWordCount}`,
    "Expand this into a detailed creative brief with stakes, core conflict, character goals, and thematic direction.",
  ].join("\n");
}

export function buildSummaryPrompt(input: UserInput, expandedPremise: string): string {
  return [
    `Book title request: ${input.bookTitle || "Auto-generate if empty"}`,
    `Language: ${input.language}`,
    `Chapter count: ${input.chapterCount}`,
    `Expanded premise:\n${expandedPremise}`,
    "Create a compact story summary from opening to ending, with turning points.",
  ].join("\n\n");
}

export function buildOutlinePrompt(input: UserInput, storySummary: string): string {
  const requestedTitle = input.bookTitle.trim();
  return [
    requestedTitle
      ? `Requested book title (must use exactly): ${requestedTitle}`
      : "Requested book title: (none provided; generate a fitting original title)",
    `Story summary:\n${storySummary}`,
    `Language: ${input.language}`,
    `Chapter count: ${input.chapterCount}`,
    `Target word count guideline: ${input.targetWordCount}`,
    "Return JSON only (no markdown). Required top-level keys: `bookTitle`, `globalStoryArc`, `chapters`.",
    "Each chapter object must include exactly: `chapterNumber`, `title`, `summary`, `targetWordsGuideline`.",
    "Do not use alternate keys like `globalArc`, `arc`, `targetWords`, `wordTarget`, or `target_words`.",
  ].join("\n\n");
}

export function buildChapterDraftPrompt(args: {
  input: UserInput;
  outline: OutlineResult;
  chapterNumber: number;
  chapterSummary: string;
  previousChapterTail: string;
}): string {
  const chapter = args.outline.chapters.find((item) => item.chapterNumber === args.chapterNumber);
  if (!chapter) throw new Error(`Missing chapter ${args.chapterNumber} in outline`);

  return [
    `Book title: ${args.outline.bookTitle}`,
    `Global story arc: ${args.outline.globalStoryArc}`,
    `Chapter ${chapter.chapterNumber}: ${chapter.title}`,
    `Chapter summary: ${chapter.summary}`,
    `Prior draft summary:\n${args.chapterSummary}`,
    args.previousChapterTail ? `Prior chapter tail:\n${args.previousChapterTail}` : "No prior chapter tail.",
    `Target words guideline: ${chapter.targetWordsGuideline}`,
    "Write a full chapter draft in markdown prose with strong scene flow.",
  ].join("\n\n");
}

export function buildStoryBlocksPrompt(args: {
  outline: OutlineResult;
  chapterNumber: number;
  chapterSummary: string;
  minBlocks: number;
  maxBlocks: number;
}): string {
  const chapter = args.outline.chapters.find((item) => item.chapterNumber === args.chapterNumber);
  if (!chapter) throw new Error(`Missing chapter ${args.chapterNumber} in outline`);

  return [
    `Book title: ${args.outline.bookTitle}`,
    `Global story arc: ${args.outline.globalStoryArc}`,
    `Chapter ${chapter.chapterNumber}: ${chapter.title}`,
    `Chapter summary: ${args.chapterSummary}`,
    `Block count range: ${args.minBlocks} to ${args.maxBlocks}`,
    "Return strict JSON story blocks for this chapter with escalating tension and continuity notes.",
  ].join("\n\n");
}

export function buildContextRequestPrompt(args: {
  chapterNumber: number;
  chapterTitle: string;
  blockNumber: number;
  blockGoal: string;
  blockEvents: string[];
  rollingSummary: string;
}): string {
  return [
    `Chapter ${args.chapterNumber}: ${args.chapterTitle}`,
    `Block ${args.blockNumber} goal: ${args.blockGoal}`,
    `Planned events: ${args.blockEvents.join("; ")}`,
    `Current rolling summary:\n${args.rollingSummary || "No rolling summary yet."}`,
    "Return strict JSON context request listing only necessary continuity dependencies.",
  ].join("\n\n");
}

export function buildBlockDraftPrompt(args: {
  outline: OutlineResult;
  chapterNumber: number;
  chapterTitle: string;
  blockNumber: number;
  blockGoal: string;
  blockEvents: string[];
  blockCharacters: string[];
  targetWordsGuideline: number;
  previousChapterTail: string;
  rollingSummary: string;
  resolvedContext: string;
}): string {
  return [
    `Book title: ${args.outline.bookTitle}`,
    `Global story arc: ${args.outline.globalStoryArc}`,
    `Chapter ${args.chapterNumber}: ${args.chapterTitle}`,
    `Block ${args.blockNumber} goal: ${args.blockGoal}`,
    `Events to include: ${args.blockEvents.join("; ")}`,
    `Characters in focus: ${args.blockCharacters.join(", ") || "None specified"}`,
    `Target words guideline: ${args.targetWordsGuideline}`,
    `Prior chapter tail:\n${args.previousChapterTail || "No prior chapter tail."}`,
    `Rolling summary:\n${args.rollingSummary || "No rolling summary yet."}`,
    `Resolved context:\n${args.resolvedContext || "No additional resolved context."}`,
    "Write only this story block in markdown prose. Preserve tonal and POV consistency.",
  ].join("\n\n");
}

export function buildMemoryUpdatePrompt(args: {
  chapterNumber: number;
  blockNumber: number;
  previousSummary: string;
  blockText: string;
}): string {
  return [
    `Chapter ${args.chapterNumber}, block ${args.blockNumber}`,
    `Previous rolling summary:\n${args.previousSummary || "No previous summary."}`,
    `New block text:\n${args.blockText}`,
    "Return strict JSON rolling summary update (plotState, characterState, openLoops, styleConstraints).",
  ].join("\n\n");
}

export function buildStoryBibleUpdatePrompt(args: {
  chapterNumber: number;
  blockNumber: number;
  blockText: string;
  currentBible: string;
}): string {
  return [
    `Chapter ${args.chapterNumber}, block ${args.blockNumber}`,
    `Current story bible state:\n${args.currentBible}`,
    `New block text:\n${args.blockText}`,
    "Return strict JSON updated story bible state with keys: characters, events, worldRules, styleAnchors.",
    "Preserve existing valid entries unless contradicted by the new block.",
  ].join("\n\n");
}

export function buildGlobalRevisionPrompt(args: { outline: OutlineResult; chapters: string[] }): string {
  return [
    `Book title: ${args.outline.bookTitle}`,
    `Global story arc: ${args.outline.globalStoryArc}`,
    `Chapter count: ${args.chapters.length}`,
    "Revise the full manuscript for continuity, pacing, character consistency, scene clarity, and style.",
    "Return full revised manuscript markdown.",
    args.chapters.map((c, i) => `## Chapter ${i + 1}\n${c}`).join("\n\n"),
  ].join("\n\n");
}

export function buildCriticPrompt(stageId: StageId, content: string): string {
  return [
    `Stage: ${stageId}`,
    "Score the content from 0 to 1 on: continuity, pacing, character consistency, scene clarity, style adherence.",
    "Return strict JSON: { score: number, notes: string }",
    `Content:\n${content}`,
  ].join("\n\n");
}

export function buildReviserPrompt(stageId: StageId, content: string, notes: string): string {
  return [
    `Stage: ${stageId}`,
    `Critic notes:\n${notes}`,
    "Revise content accordingly while preserving narrative intent.",
    `Current content:\n${content}`,
  ].join("\n\n");
}

export function buildPlannerPrompt(args: {
  stageId: StageId;
  pass: number;
  score: number;
  delta: number;
  nextStageId: StageId;
}): string {
  return [
    "You are a stage planner for a novel-generation pipeline.",
    `Current stage: ${args.stageId}`,
    `Pass: ${args.pass}`,
    `Score: ${args.score}`,
    `Delta: ${args.delta}`,
    `Recommended next stage: ${args.nextStageId}`,
    "Return one concise rationale sentence.",
  ].join("\n");
}

export function getTailByWords(text: string, wordLimit: number): string {
  if (!text.trim()) return "";
  const words = text.trim().split(/\s+/);
  if (words.length <= wordLimit) return text;
  return words.slice(words.length - wordLimit).join(" ");
}
