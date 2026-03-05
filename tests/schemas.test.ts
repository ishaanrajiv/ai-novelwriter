import { describe, expect, test } from "bun:test";

import {
  OutlineResultSchema,
  StoryBlocksResultSchema,
  UserInputSchema,
} from "../src/schemas/contracts.js";

describe("schemas", () => {
  test("validates user input", () => {
    const parsed = UserInputSchema.parse({
      bookTitle: "Book",
      author: "Author",
      language: "en",
      premise: "Premise",
      chapterCount: 3,
      targetWordCount: 15000,
      systemPromptTemplate: {
        tone: "Warm",
        pov: "Third",
        tense: "Past",
        style: "Lyrical",
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
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        jitterRatio: 0.15,
      },
    });

    expect(parsed.chapterCount).toBe(3);
  });

  test("allows blank user-provided title for auto-generation", () => {
    const parsed = UserInputSchema.parse({
      bookTitle: "",
      author: "Author",
      language: "en",
      premise: "Premise",
      chapterCount: 3,
      targetWordCount: 15000,
      systemPromptTemplate: {
        tone: "Warm",
        pov: "Third",
        tense: "Past",
        style: "Lyrical",
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
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        jitterRatio: 0.15,
      },
    });

    expect(parsed.bookTitle).toBe("");
  });

  test("validates outline output", () => {
    const parsed = OutlineResultSchema.parse({
      bookTitle: "Generated Title",
      globalStoryArc: "Arc",
      chapters: [
        { chapterNumber: 1, title: "Start", summary: "Summary", targetWordsGuideline: 4000 },
      ],
    });
    expect(parsed.chapters.length).toBe(1);
  });

  test("validates blocks output", () => {
    const parsed = StoryBlocksResultSchema.parse({
      chapterNumber: 1,
      chapterTitle: "Start",
      blocks: [
        {
          blockNumber: 1,
          goal: "Goal",
          events: ["Event"],
          characters: ["A"],
          continuityNotes: ["Note"],
          targetWordsGuideline: 900,
        },
      ],
    });

    expect(parsed.blocks[0]?.events[0]).toBe("Event");
  });
});
