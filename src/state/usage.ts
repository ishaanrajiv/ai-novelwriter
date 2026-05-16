import { access } from "node:fs/promises";

import type { LLMClient, LLMUsage } from "../llm/provider.js";
import { readJsonFile, writeJsonAtomic } from "../utils/fs.js";

export interface UsageRequestLogEntry {
  timestamp: string;
  provider: string;
  model: string;
  usagePayload: LLMUsage | null;
  inputTokens: number;
  outputTokens: number;
  runDurationMs: number;
}

export interface UsageSummary {
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRunDurationMs: number;
  providers: Record<string, { requestCount: number; inputTokens: number; outputTokens: number; runDurationMs: number }>;
  models: Record<string, { requestCount: number; inputTokens: number; outputTokens: number; runDurationMs: number }>;
  updatedAt: string;
}

const usageWriteQueue = new Map<string, Promise<void>>();

function deriveInputTokens(usage?: LLMUsage): number {
  return typeof usage?.inputTokens === "number" ? usage.inputTokens : 0;
}

function deriveOutputTokens(usage?: LLMUsage): number {
  return typeof usage?.outputTokens === "number" ? usage.outputTokens : 0;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    await access(filePath);
    return await readJsonFile<T>(filePath);
  } catch {
    return null;
  }
}

function emptySummary(nowIso: string): UsageSummary {
  return {
    requestCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalRunDurationMs: 0,
    providers: {},
    models: {},
    updatedAt: nowIso,
  };
}

export async function appendUsageLog(args: {
  requestPath: string;
  summaryPath: string;
  entry: UsageRequestLogEntry;
}): Promise<void> {
  const queueKey = `${args.requestPath}::${args.summaryPath}`;
  const previous = usageWriteQueue.get(queueKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const [requestLog, summary] = await Promise.all([
      readJsonIfExists<UsageRequestLogEntry[]>(args.requestPath),
      readJsonIfExists<UsageSummary>(args.summaryPath),
    ]);

    const requests = Array.isArray(requestLog) ? requestLog : [];
    requests.push(args.entry);

    const nextSummary = summary ?? emptySummary(args.entry.timestamp);
    nextSummary.requestCount += 1;
    nextSummary.totalInputTokens += args.entry.inputTokens;
    nextSummary.totalOutputTokens += args.entry.outputTokens;
    nextSummary.totalRunDurationMs += args.entry.runDurationMs;

    const providerBucket = nextSummary.providers[args.entry.provider] ?? { requestCount: 0, inputTokens: 0, outputTokens: 0, runDurationMs: 0 };
    providerBucket.requestCount += 1;
    providerBucket.inputTokens += args.entry.inputTokens;
    providerBucket.outputTokens += args.entry.outputTokens;
    providerBucket.runDurationMs += args.entry.runDurationMs;
    nextSummary.providers[args.entry.provider] = providerBucket;

    const modelBucket = nextSummary.models[args.entry.model] ?? { requestCount: 0, inputTokens: 0, outputTokens: 0, runDurationMs: 0 };
    modelBucket.requestCount += 1;
    modelBucket.inputTokens += args.entry.inputTokens;
    modelBucket.outputTokens += args.entry.outputTokens;
    modelBucket.runDurationMs += args.entry.runDurationMs;
    nextSummary.models[args.entry.model] = modelBucket;

    nextSummary.updatedAt = args.entry.timestamp;

    await Promise.all([
      writeJsonAtomic(args.requestPath, requests),
      writeJsonAtomic(args.summaryPath, nextSummary),
    ]);
  });

  usageWriteQueue.set(queueKey, next);
  try {
    await next;
  } finally {
    if (usageWriteQueue.get(queueKey) === next) usageWriteQueue.delete(queueKey);
  }
}

function runDurationMs(startMs: number): number {
  return Math.max(0, Math.round(Date.now() - startMs));
}

export function wrapLLMClientWithUsageLogging(args: {
  llmClient: LLMClient;
  provider: string;
  requestPath: string;
  summaryPath: string;
}): LLMClient {
  return {
    async generateText(options) {
      const startedAt = Date.now();
      const result = await args.llmClient.generateText(options);
      const timestamp = new Date().toISOString();
      const usage = result.usage;
      await appendUsageLog({
        requestPath: args.requestPath,
        summaryPath: args.summaryPath,
        entry: {
          timestamp,
          provider: args.provider,
          model: options.model,
          usagePayload: usage ?? null,
          inputTokens: deriveInputTokens(usage),
          outputTokens: deriveOutputTokens(usage),
          runDurationMs: runDurationMs(startedAt),
        },
      });
      return result;
    },

    async generateJson<T>(options) {
      const startedAt = Date.now();
      const result = await args.llmClient.generateJson(options);
      const timestamp = new Date().toISOString();
      const usage = result.usage;
      await appendUsageLog({
        requestPath: args.requestPath,
        summaryPath: args.summaryPath,
        entry: {
          timestamp,
          provider: args.provider,
          model: options.model,
          usagePayload: usage ?? null,
          inputTokens: deriveInputTokens(usage),
          outputTokens: deriveOutputTokens(usage),
          runDurationMs: runDurationMs(startedAt),
        },
      });
      return result;
    },
  };
}
