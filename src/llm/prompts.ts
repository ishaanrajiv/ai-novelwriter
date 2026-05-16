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
    "Prioritize concrete story construction over abstract theme language.",
    "Write operational narrative guidance: specific events, choices, consequences, and constraints.",
    "Avoid vague statements that cannot be directly used to draft scenes and chapters.",
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
    "Expand this into a chapter-actionable creative brief.",
    "Output markdown with these exact sections:",
    "1) Core Story Engine: protagonist goal, antagonist pressure, central dilemma, failure cost.",
    "2) Character Operating Profiles: for each core character include external goal, internal wound, fear, leverage over others, likely bad decision pattern.",
    "3) World and Conflict Rules: non-negotiable rules, institutions/factions, constraints that create conflict.",
    "4) Act-Level Progression: setup, escalation, crisis, climax, resolution with concrete turning points.",
    "5) Chapter-Seeding Material: 12-25 specific plot beats that can be mapped to chapters.",
    "6) Continuity Guardrails: forbidden contradictions, tone limits, POV limits, and recurring motifs to maintain.",
    "Requirements: every bullet must include observable actions or outcomes; avoid abstract-only phrasing.",
  ].join("\n");
}

export function buildSummaryPrompt(input: UserInput, expandedPremise: string): string {
  return [
    `Book title request: ${input.bookTitle || "Auto-generate if empty"}`,
    `Language: ${input.language}`,
    `Chapter count: ${input.chapterCount}`,
    `Expanded premise:\n${expandedPremise}`,
    "Create a concrete, chapter-writer-ready story summary from opening to ending.",
    "Output markdown with these exact sections:",
    "1) One-Paragraph Spine: protagonist objective, opposition, stakes, irreversible choice at end.",
    "2) Chronological Beatline: 18-35 numbered beats, each in cause -> action -> consequence form.",
    "3) Character Arc Tracks: for each core character list start state, pressure points, breaking point, end state.",
    "4) Escalation Ladder: how conflict intensifies across early/mid/late story with specific reversals.",
    "5) Endgame Logic: why the final outcome is earned based on prior events.",
    "Requirements: no poetic/thematic filler; each line must be directly usable for outlining or drafting.",
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
    "Each `summary` must be 80-170 words and include: opening situation, chapter objective, 2-4 concrete events, decision/reversal, and ending state that pushes the next chapter.",
    "Across all chapters, maintain strict cause-and-effect continuity and escalation; no duplicate chapter functions.",
    "`globalStoryArc` must summarize the progression in concrete milestones, not abstract themes.",
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
    "Return JSON only (no markdown). Required top-level keys: `chapterNumber`, `chapterTitle`, `blocks`.",
    "Each block object must include exactly: `blockNumber`, `goal`, `events`, `characters`, `continuityNotes`, `targetWordsGuideline`.",
    "Do not use alternate keys like `scenes`, `beats`, `targetWords`, or `wordTarget`.",
    "Design escalating tension and continuity notes across blocks.",
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
