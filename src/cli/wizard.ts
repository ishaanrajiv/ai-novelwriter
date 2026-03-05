import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { AppConfigSchema, type AppConfig, type UserInput } from "../schemas/contracts.js";

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

async function ask(rl: ReturnType<typeof createInterface>, label: string, fallback: string): Promise<string> {
  const answer = await rl.question(`${label} [${fallback}]: `);
  return answer.trim() || fallback;
}

export async function runInteractiveWizard(artifactsRoot: string): Promise<AppConfig> {
  const rl = createInterface({ input, output });

  try {
    const bookTitle = await ask(rl, "Book title", "Untitled Novel");
    const author = await ask(rl, "Author", "Anonymous");
    const language = await ask(rl, "Language", "en");
    const premise = await ask(rl, "Premise", "A character faces escalating conflict and transforms.");
    const chapterCount = toInt(await ask(rl, "Chapter count", "12"), 12);
    const targetWordCount = toInt(await ask(rl, "Target word count", "80000"), 80000);

    const defaultModel = await ask(rl, "Default model (OpenRouter id)", "openai/gpt-4.1-mini");
    const outlineModel = await ask(rl, "Outline model override (optional)", "");
    const blocksModel = await ask(rl, "Blocks model override (optional)", "");
    const chapterModel = await ask(rl, "Chapter model override (optional)", "");
    const memoryModel = await ask(rl, "Memory model override (optional)", "");

    const tone = await ask(rl, "Prompt template: tone", "Cinematic and immersive");
    const pov = await ask(rl, "Prompt template: POV", "Third-person limited");
    const tense = await ask(rl, "Prompt template: tense", "Past tense");
    const style = await ask(rl, "Prompt template: style", "Modern literary prose with clear pacing");
    const constraints = await ask(
      rl,
      "Prompt template: constraints",
      "Maintain continuity, avoid repetition, and keep dialogue natural",
    );
    const custom = await ask(rl, "Prompt template: custom", "");

    const minBlocksPerChapter = toInt(await ask(rl, "Min blocks per chapter", "3"), 3);
    const maxBlocksPerChapter = toInt(await ask(rl, "Max blocks per chapter", "8"), 8);

    const maxRetries = toInt(await ask(rl, "Retry max retries", "3"), 3);
    const baseDelayMs = toInt(await ask(rl, "Retry base delay ms", "750"), 750);
    const maxDelayMs = toInt(await ask(rl, "Retry max delay ms", "8000"), 8000);
    const jitterRatio = Number.parseFloat(await ask(rl, "Retry jitter ratio", "0.15")) || 0.15;

    const userInput: UserInput = {
      bookTitle,
      author,
      language,
      premise,
      chapterCount,
      targetWordCount,
      systemPromptTemplate: {
        tone,
        pov,
        tense,
        style,
        constraints,
        custom,
      },
      modelConfig: {
        defaultModel,
        ...(outlineModel ? { outlineModel } : {}),
        ...(blocksModel ? { blocksModel } : {}),
        ...(chapterModel ? { chapterModel } : {}),
        ...(memoryModel ? { memoryModel } : {}),
      },
      blockPolicy: {
        minBlocksPerChapter,
        maxBlocksPerChapter,
      },
      retryPolicy: {
        maxRetries,
        baseDelayMs,
        maxDelayMs,
        jitterRatio,
      },
    };

    return AppConfigSchema.parse({
      userInput,
      runtime: {
        artifactsRoot,
      },
    });
  } finally {
    rl.close();
  }
}
