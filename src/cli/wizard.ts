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

function toFloat(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value.trim());
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

    const providerType = await ask(rl, "Provider (lmstudio|openrouter)", "lmstudio");
    const defaultModel = await ask(rl, "Default model id", "google/gemma-4-e4b");
    const outlineModel = options.askAdvancedArgs ? await ask(rl, "Outline model override (optional)", "") : "";
    const blocksModel = options.askAdvancedArgs ? await ask(rl, "Blocks model override (optional)", "") : "";
    const chapterModel = options.askAdvancedArgs ? await ask(rl, "Chapter model override (optional)", "") : "";
    const memoryModel = options.askAdvancedArgs ? await ask(rl, "Memory model override (optional)", "") : "";

    const lmstudioBaseUrl = options.askAdvancedArgs
      ? await ask(rl, "LM Studio base URL", "http://127.0.0.1:1234/v1")
      : "http://127.0.0.1:1234/v1";

    const tone = options.askAdvancedArgs ? await ask(rl, "Prompt template: tone", "Cinematic and immersive") : "Cinematic and immersive";
    const pov = options.askAdvancedArgs ? await ask(rl, "Prompt template: POV", "Third-person limited") : "Third-person limited";
    const tense = options.askAdvancedArgs ? await ask(rl, "Prompt template: tense", "Past tense") : "Past tense";
    const style = options.askAdvancedArgs
      ? await ask(rl, "Prompt template: style", "Modern literary prose with clear pacing")
      : "Modern literary prose with clear pacing";
    const constraints = options.askAdvancedArgs
      ? await ask(rl, "Prompt template: constraints", "Maintain continuity, avoid repetition, and keep dialogue natural")
      : "Maintain continuity, avoid repetition, and keep dialogue natural";
    const custom = options.askAdvancedArgs ? await ask(rl, "Prompt template: custom", "") : "";

    const minPassesPerStage = options.askAdvancedArgs ? toInt(await ask(rl, "Iteration min passes per stage", "1"), 1) : 1;
    const maxPassesPerStage = options.askAdvancedArgs ? toInt(await ask(rl, "Iteration max passes per stage", "3"), 3) : 3;
    const convergenceWindow = options.askAdvancedArgs ? toInt(await ask(rl, "Iteration convergence window", "2"), 2) : 2;
    const deltaThreshold = options.askAdvancedArgs ? toFloat(await ask(rl, "Iteration delta threshold", "0.02"), 0.02) : 0.02;
    const qualityFloor = options.askAdvancedArgs ? toFloat(await ask(rl, "Iteration quality floor", "0.8"), 0.8) : 0.8;

    const minBlocksPerChapter = options.askAdvancedArgs ? toInt(await ask(rl, "Min blocks per chapter", "3"), 3) : 3;
    const maxBlocksPerChapter = options.askAdvancedArgs ? toInt(await ask(rl, "Max blocks per chapter", "8"), 8) : 8;

    const maxRetries = options.askAdvancedArgs ? toInt(await ask(rl, "Retry max retries", "3"), 3) : 3;
    const baseDelayMs = options.askAdvancedArgs ? toInt(await ask(rl, "Retry base delay ms", "750"), 750) : 750;
    const maxDelayMs = options.askAdvancedArgs ? toInt(await ask(rl, "Retry max delay ms", "8000"), 8000) : 8000;
    const jitterRatio = options.askAdvancedArgs ? toFloat(await ask(rl, "Retry jitter ratio", "0.15"), 0.15) : 0.15;

    const userInput: UserInput = {
      bookTitle,
      author,
      language,
      premise,
      chapterCount,
      targetWordCount,
      provider: {
        type: providerType === "openrouter" ? "openrouter" : "lmstudio",
        lmstudio: {
          baseUrl: lmstudioBaseUrl,
          apiKeyEnv: "LMSTUDIO_API_KEY",
        },
        openrouter: {
          apiKeyEnv: "OPENROUTER_API_KEY",
          httpRefererEnv: "OPENROUTER_HTTP_REFERER",
          appNameEnv: "OPENROUTER_APP_NAME",
        },
      },
      systemPromptTemplate: { tone, pov, tense, style, constraints, custom },
      modelConfig: {
        defaultModel,
        ...(outlineModel ? { outlineModel } : {}),
        ...(blocksModel ? { blocksModel } : {}),
        ...(chapterModel ? { chapterModel } : {}),
        ...(memoryModel ? { memoryModel } : {}),
      },
      iterationPolicy: {
        minPassesPerStage,
        maxPassesPerStage,
        convergenceWindow,
        deltaThreshold,
        manualApprovalMode: false,
        qualityFloor,
      },
      blockPolicy: { minBlocksPerChapter, maxBlocksPerChapter },
      retryPolicy: { maxRetries, baseDelayMs, maxDelayMs, jitterRatio },
    };

    return AppConfigSchema.parse({
      userInput,
      runtime: { artifactsRoot },
    });
  } finally {
    rl.close();
  }
}
