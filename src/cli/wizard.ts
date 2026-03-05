import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { AppConfigSchema, type AppConfig, type UserInput } from "../schemas/contracts.js";

type WizardOptions = {
  askAdvancedArgs: boolean;
};

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

async function ask(rl: ReturnType<typeof createInterface>, label: string, fallback: string): Promise<string> {
  const answer = await rl.question(`${label} [${fallback}]: `);
  return answer.trim() || fallback;
}

async function askOptional(rl: ReturnType<typeof createInterface>, label: string, hint: string): Promise<string> {
  const answer = await rl.question(`${label} [${hint}]: `);
  return answer.trim();
}

export async function runInteractiveWizard(artifactsRoot: string, options: WizardOptions): Promise<AppConfig> {
  const rl = createInterface({ input, output });

  try {
    const bookTitle = await askOptional(rl, "Book title", "Leave Blank for Auto Generate");
    const author = await ask(rl, "Author", "Anonymous");
    const language = await ask(rl, "Language", "en");
    const premise = await ask(rl, "Premise", "A character faces escalating conflict and transforms.");
    const chapterCount = toInt(await ask(rl, "Chapter count", "12"), 12);
    const targetWordCount = toInt(await ask(rl, "Target word count", "80000"), 80000);

    const defaultModel = await ask(rl, "Default model (OpenRouter id)", "openai/gpt-4.1-mini");
    const outlineModel = options.askAdvancedArgs ? await ask(rl, "Outline model override (optional)", "") : "";
    const blocksModel = options.askAdvancedArgs ? await ask(rl, "Blocks model override (optional)", "") : "";
    const chapterModel = options.askAdvancedArgs ? await ask(rl, "Chapter model override (optional)", "") : "";
    const memoryModel = options.askAdvancedArgs ? await ask(rl, "Memory model override (optional)", "") : "";

    const tone = options.askAdvancedArgs ? await ask(rl, "Prompt template: tone", "Cinematic and immersive") : "Cinematic and immersive";
    const pov = options.askAdvancedArgs ? await ask(rl, "Prompt template: POV", "Third-person limited") : "Third-person limited";
    const tense = options.askAdvancedArgs ? await ask(rl, "Prompt template: tense", "Past tense") : "Past tense";
    const style = options.askAdvancedArgs
      ? await ask(rl, "Prompt template: style", "Modern literary prose with clear pacing")
      : "Modern literary prose with clear pacing";
    const constraints = options.askAdvancedArgs
      ? await ask(
          rl,
          "Prompt template: constraints",
          "Maintain continuity, avoid repetition, and keep dialogue natural",
        )
      : "Maintain continuity, avoid repetition, and keep dialogue natural";
    const custom = options.askAdvancedArgs ? await ask(rl, "Prompt template: custom", "") : "";

    const minBlocksPerChapter = options.askAdvancedArgs ? toInt(await ask(rl, "Min blocks per chapter", "3"), 3) : 3;
    const maxBlocksPerChapter = options.askAdvancedArgs ? toInt(await ask(rl, "Max blocks per chapter", "8"), 8) : 8;

    const maxRetries = options.askAdvancedArgs ? toInt(await ask(rl, "Retry max retries", "3"), 3) : 3;
    const baseDelayMs = options.askAdvancedArgs ? toInt(await ask(rl, "Retry base delay ms", "750"), 750) : 750;
    const maxDelayMs = options.askAdvancedArgs ? toInt(await ask(rl, "Retry max delay ms", "8000"), 8000) : 8000;
    const jitterRatio = options.askAdvancedArgs
      ? Number.parseFloat(await ask(rl, "Retry jitter ratio", "0.15")) || 0.15
      : 0.15;

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
