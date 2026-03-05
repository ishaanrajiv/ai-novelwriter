import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, generateText } from "ai";
import { z } from "zod";

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface JsonGenerationOptions<T> {
  stage: string;
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}

export interface TextGenerationOptions {
  stage: string;
  model: string;
  system: string;
  prompt: string;
}

export interface LLMClient {
  generateJson<T>(options: JsonGenerationOptions<T>): Promise<{ object: T; usage?: LLMUsage }>;
  generateText(options: TextGenerationOptions): Promise<{ text: string; usage?: LLMUsage }>;
}

function extractUsage(input: unknown): LLMUsage | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const usage = input as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  if (!usage.inputTokens && !usage.outputTokens && !usage.totalTokens) {
    return undefined;
  }

  const normalized: LLMUsage = {};
  if (typeof usage.inputTokens === "number") {
    normalized.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number") {
    normalized.outputTokens = usage.outputTokens;
  }
  if (typeof usage.totalTokens === "number") {
    normalized.totalTokens = usage.totalTokens;
  }
  return normalized;
}

export function createOpenRouterLLMClient(): LLMClient {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required");
  }

  const provider = createOpenRouter({
    apiKey,
    compatibility: "strict",
    headers: {
      "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER ?? "https://localhost/ai-novelwriter",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "AI Novel Writer",
    },
  });

  return {
    async generateJson<T>(options: JsonGenerationOptions<T>): Promise<{ object: T; usage?: LLMUsage }> {
      const result = await generateObject({
        model: provider(options.model),
        system: options.system,
        prompt: options.prompt,
        schema: options.schema,
      });
      const usage = extractUsage(result.usage);

      return {
        object: result.object,
        ...(usage ? { usage } : {}),
      };
    },

    async generateText(options: TextGenerationOptions): Promise<{ text: string; usage?: LLMUsage }> {
      const result = await generateText({
        model: provider(options.model),
        system: options.system,
        prompt: options.prompt,
      });
      const usage = extractUsage(result.usage);

      return {
        text: result.text,
        ...(usage ? { usage } : {}),
      };
    },
  };
}
