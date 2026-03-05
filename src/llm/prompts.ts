import type {
  OutlineResult,
  RollingSummary,
  StoryBlock,
  StoryBlocksResult,
  SystemPromptTemplate,
  UserInput,
} from "../types/index.js";

export function buildSystemPrompt(template: SystemPromptTemplate): string {
  return [
    "You are a professional fiction writer.",
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

export function buildOutlinePrompt(input: UserInput): string {
  return [
    `Book title: ${input.bookTitle}`,
    `Premise: ${input.premise}`,
    `Language: ${input.language}`,
    `Chapter count: ${input.chapterCount}`,
    `Target word count guideline: ${input.targetWordCount}`,
    "Return a chapter-by-chapter outline JSON that strictly matches the schema.",
    "Distribute words as a guideline only, not strict limits.",
  ].join("\n");
}

export function buildBlocksPrompt(args: {
  input: UserInput;
  outline: OutlineResult;
  chapterNumber: number;
}): string {
  const chapter = args.outline.chapters.find((item) => item.chapterNumber === args.chapterNumber);
  if (!chapter) {
    throw new Error(`Missing chapter ${args.chapterNumber} in outline`);
  }

  return [
    `Book title: ${args.input.bookTitle}`,
    `Global story arc: ${args.outline.globalStoryArc}`,
    `Chapter number: ${chapter.chapterNumber}`,
    `Chapter title: ${chapter.title}`,
    `Chapter summary: ${chapter.summary}`,
    `Block count bounds: ${args.input.blockPolicy.minBlocksPerChapter}-${args.input.blockPolicy.maxBlocksPerChapter}`,
    "Return JSON with plot blocks that include character/event continuity details.",
    "Ensure block numbering starts at 1 and is sequential.",
  ].join("\n");
}

export function buildChapterBlockPrompt(args: {
  input: UserInput;
  outline: OutlineResult;
  chapterPlan: StoryBlocksResult;
  block: StoryBlock;
  previousChapterTail: string;
  rollingSummary: RollingSummary;
  isFirstBlock: boolean;
}): string {
  const chapter = args.outline.chapters.find((item) => item.chapterNumber === args.chapterPlan.chapterNumber);
  if (!chapter) {
    throw new Error(`Missing chapter ${args.chapterPlan.chapterNumber} in outline`);
  }

  return [
    `Book title: ${args.input.bookTitle}`,
    `Global story arc: ${args.outline.globalStoryArc}`,
    `Chapter ${chapter.chapterNumber}: ${chapter.title}`,
    `Chapter summary: ${chapter.summary}`,
    `Current block #${args.block.blockNumber}`,
    `Block goal: ${args.block.goal}`,
    `Block events: ${args.block.events.join(" | ")}`,
    `Block characters: ${args.block.characters.join(" | ") || "None"}`,
    `Continuity notes: ${args.block.continuityNotes.join(" | ") || "None"}`,
    `Target words guideline for this block: ${args.block.targetWordsGuideline}`,
    args.isFirstBlock ? "This is the first block in the chapter." : "Continue seamlessly from prior chapter text.",
    `Rolling continuity summary:\n${JSON.stringify(args.rollingSummary, null, 2)}`,
    args.previousChapterTail
      ? `Recent chapter tail text (for continuity):\n${args.previousChapterTail}`
      : "No previous chapter tail text yet.",
    "Return JSON with `text` and `updatedSummary`.",
  ].join("\n\n");
}

export function buildChapterFinalizeText(blockTexts: string[]): string {
  return blockTexts.join("\n\n").trim();
}

export function getTailByWords(text: string, wordLimit: number): string {
  if (!text.trim()) {
    return "";
  }

  const words = text.trim().split(/\s+/);
  if (words.length <= wordLimit) {
    return text;
  }

  return words.slice(words.length - wordLimit).join(" ");
}

export function initialRollingSummary(): RollingSummary {
  return {
    plotState: "Story start; no chapter content generated yet.",
    characterState: "No additional state beyond outline.",
    openLoops: [],
    styleConstraints: [],
  };
}
