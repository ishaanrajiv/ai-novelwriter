import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

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

interface LLMClientRuntimeOptions {
  sessionId?: string;
}

function extractUsage(inputValue: unknown): LLMUsage | undefined {
  if (!inputValue || typeof inputValue !== "object") return undefined;
  const usage = inputValue as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  const normalized: LLMUsage = {};
  if (typeof usage.inputTokens === "number") normalized.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number") normalized.outputTokens = usage.outputTokens;
  if (typeof usage.totalTokens === "number") normalized.totalTokens = usage.totalTokens;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function makeOpenRouterClient(modelResolver: (model: string) => unknown): LLMClient {
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

export function createOpenRouterLLMClient(
  provider: ProviderConfig["openrouter"],
  runtimeOptions?: LLMClientRuntimeOptions,
): LLMClient {
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`${provider.apiKeyEnv} is required for OpenRouter`);
  }
  const sessionId = runtimeOptions?.sessionId?.trim() || process.env[provider.sessionIdEnv]?.trim();

  const openRouter = createOpenRouter({
    apiKey,
    compatibility: "strict",
    headers: {
      "HTTP-Referer": process.env[provider.httpRefererEnv] ?? "https://localhost/ai-novelwriter",
      "X-Title": process.env[provider.appNameEnv] ?? "AI Novel Writer",
    },
    ...(sessionId ? { extraBody: { session_id: sessionId } } : {}),
  });

  return makeOpenRouterClient((model) => openRouter(model));
}

interface LmStudioChatChoice {
  message?: { content?: string };
}

interface LmStudioChatResponse {
  choices?: LmStudioChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function optionalApiKey(value: string | undefined): { apiKey?: string } {
  return value ? { apiKey: value } : {};
}

function lmUsageToCommon(usage?: LmStudioChatResponse["usage"]): LLMUsage | undefined {
  if (!usage) return undefined;
  const normalized: LLMUsage = {};
  if (typeof usage.prompt_tokens === "number") normalized.inputTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") normalized.outputTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") normalized.totalTokens = usage.total_tokens;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

async function lmStudioChatCompletion(args: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  system: string;
  prompt: string;
  stage: string;
}): Promise<{ text: string; usage?: LLMUsage }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    if (process.env.NOVELWRITER_DEBUG === "1") {
      console.error(`[llm] lmstudio:start stage=${args.stage} model=${args.model}`);
    }

    const response = await fetch(`${args.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.prompt },
        ],
        temperature: 0.7,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LM Studio HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = (await response.json()) as LmStudioChatResponse;
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error("LM Studio returned empty completion content");
    }

    if (process.env.NOVELWRITER_DEBUG === "1") {
      console.error(`[llm] lmstudio:done stage=${args.stage} model=${args.model}`);
    }

    const usage = lmUsageToCommon(data.usage);
    return { text, ...(usage ? { usage } : {}) };
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new Error(`LM Studio request timed out after 120000ms (stage=${args.stage}, model=${args.model})`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function createLmStudioLLMClient(provider: ProviderConfig["lmstudio"]): LLMClient {
  const apiKey = process.env[provider.apiKeyEnv];

  return {
    async generateText(options: TextGenerationOptions): Promise<{ text: string; usage?: LLMUsage }> {
      return lmStudioChatCompletion({
        baseUrl: provider.baseUrl,
        ...optionalApiKey(apiKey),
        model: options.model,
        system: options.system,
        prompt: options.prompt,
        stage: options.stage,
      });
    },

    async generateJson<T>(options: JsonGenerationOptions<T>): Promise<{ object: T; usage?: LLMUsage }> {
      const jsonPrompt = [
        options.prompt,
        "\n\nReturn valid JSON only. No markdown fences. No explanation.",
      ].join("\n");

      const result = await lmStudioChatCompletion({
        baseUrl: provider.baseUrl,
        ...optionalApiKey(apiKey),
        model: options.model,
        system: options.system,
        prompt: jsonPrompt,
        stage: options.stage,
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.text);
      } catch (error) {
        throw new Error(`Failed to parse JSON from LM Studio for stage ${options.stage}: ${(error as Error).message}`);
      }

      return {
        object: options.schema.parse(parsed),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
  };
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

export async function createLLMClient(
  providerConfig: ProviderConfig,
  runtimeOptions?: LLMClientRuntimeOptions,
): Promise<LLMClient> {
  if (providerConfig.type === "openrouter") return createOpenRouterLLMClient(providerConfig.openrouter, runtimeOptions);

  while (true) {
    const ok = await healthCheckLmStudio(providerConfig.lmstudio.baseUrl);
    if (ok) return createLmStudioLLMClient(providerConfig.lmstudio);

    const next = await askLmStudioFallback();
    if (next === "retry") continue;
    if (next === "switch") return createOpenRouterLLMClient(providerConfig.openrouter, runtimeOptions);
    throw new Error("LM Studio unavailable. Exiting by user choice.");
  }
}
