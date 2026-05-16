import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, generateText } from "ai";
import { z } from "zod";

import type { ProviderConfig } from "../types/index.js";

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

function extractUsage(inputValue: unknown): LLMUsage | undefined {
  if (!inputValue || typeof inputValue !== "object") {
    return undefined;
  }

  const usage = inputValue as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  if (!usage.inputTokens && !usage.outputTokens && !usage.totalTokens) {
    return undefined;
  }

  const normalized: LLMUsage = {};
  if (typeof usage.inputTokens === "number") normalized.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number") normalized.outputTokens = usage.outputTokens;
  if (typeof usage.totalTokens === "number") normalized.totalTokens = usage.totalTokens;
  return normalized;
}

function makeClient(modelResolver: (model: string) => unknown): LLMClient {
  return {
    async generateJson<T>(options: JsonGenerationOptions<T>): Promise<{ object: T; usage?: LLMUsage }> {
      const result = await generateObject({
        model: modelResolver(options.model) as never,
        system: options.system,
        prompt: options.prompt,
        schema: options.schema,
      });
      const usage = extractUsage(result.usage);
      return { object: result.object, ...(usage ? { usage } : {}) };
    },
    async generateText(options: TextGenerationOptions): Promise<{ text: string; usage?: LLMUsage }> {
      const result = await generateText({
        model: modelResolver(options.model) as never,
        system: options.system,
        prompt: options.prompt,
      });
      const usage = extractUsage(result.usage);
      return { text: result.text, ...(usage ? { usage } : {}) };
    },
  };
}

export function createOpenRouterLLMClient(provider: ProviderConfig["openrouter"]): LLMClient {
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`${provider.apiKeyEnv} is required for OpenRouter`);
  }

  const openRouter = createOpenRouter({
    apiKey,
    compatibility: "strict",
    headers: {
      "HTTP-Referer": process.env[provider.httpRefererEnv] ?? "https://localhost/ai-novelwriter",
      "X-Title": process.env[provider.appNameEnv] ?? "AI Novel Writer",
    },
  });

  return makeClient((model) => openRouter(model));
}

export function createLmStudioLLMClient(provider: ProviderConfig["lmstudio"]): LLMClient {
  const apiKey = process.env[provider.apiKeyEnv] ?? "lm-studio";
  const openai = createOpenAI({
    apiKey,
    baseURL: provider.baseUrl,
  });

  // LM Studio's OpenAI-compatible server is most reliable with chat completions.
  // AI SDK OpenAI provider defaults to Responses API, which can hang/fail on local servers.
  return makeClient((model) => openai.chat(model));
}

async function healthCheckLmStudio(baseUrl: string): Promise<boolean> {
  const modelsUrl = `${baseUrl.replace(/\/$/, "")}/models`;
  try {
    const response = await fetch(modelsUrl, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function askLmStudioFallback(): Promise<"retry" | "switch" | "exit"> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("LM Studio is unavailable and interactive fallback requires a TTY.");
  }

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const ans = (await rl.question("LM Studio unavailable. Choose: [1] Retry [2] Switch to OpenRouter [3] Exit: ")).trim();
      if (ans === "1") return "retry";
      if (ans === "2") return "switch";
      if (ans === "3") return "exit";
    }
  } finally {
    rl.close();
  }
}

export async function createLLMClient(providerConfig: ProviderConfig): Promise<LLMClient> {
  if (providerConfig.type === "openrouter") {
    return createOpenRouterLLMClient(providerConfig.openrouter);
  }

  while (true) {
    const ok = await healthCheckLmStudio(providerConfig.lmstudio.baseUrl);
    if (ok) {
      return createLmStudioLLMClient(providerConfig.lmstudio);
    }

    const next = await askLmStudioFallback();
    if (next === "retry") {
      continue;
    }
    if (next === "switch") {
      return createOpenRouterLLMClient(providerConfig.openrouter);
    }
    throw new Error("LM Studio unavailable. Exiting by user choice.");
  }
}
