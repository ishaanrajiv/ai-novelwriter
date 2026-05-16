import path from "node:path";

import type { RuntimeConfig, UserInput } from "../types/index.js";
import { ProjectManifestSchema, type CheckpointStatus, type ProjectManifest } from "../schemas/contracts.js";
import { ensureDir, nextAttemptNumber, readJsonFile, writeJsonAtomic, writeTextAtomic } from "../utils/fs.js";
import { blockKey, chapterKey } from "../utils/ids.js";

export interface ProjectPaths {
  projectDir: string;
  manifestPath: string;
  inputPath: string;
  projectYamlPath: string;
  premiseDir: string;
  summaryDir: string;
  outlineDir: string;
  chapterDir: string;
  globalRevisionDir: string;
  plannerDir: string;
  exportDir: string;
}

export function getProjectPaths(artifactsRootAbs: string, projectId: string): ProjectPaths {
  const projectDir = path.join(artifactsRootAbs, projectId);
  return {
    projectDir,
    manifestPath: path.join(projectDir, "manifest.json"),
    inputPath: path.join(projectDir, "inputs", "user-input.json"),
    projectYamlPath: path.join(projectDir, "project.yaml"),
    premiseDir: path.join(projectDir, "stage0-premise"),
    summaryDir: path.join(projectDir, "stage1-summary"),
    outlineDir: path.join(projectDir, "stage2-outline"),
    chapterDir: path.join(projectDir, "stage3-chapters"),
    globalRevisionDir: path.join(projectDir, "stage4-global-revision"),
    plannerDir: path.join(projectDir, "planner"),
    exportDir: path.join(projectDir, "exports", "epub"),
  };
}

export async function initProjectDirs(paths: ProjectPaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.projectDir),
    ensureDir(path.dirname(paths.inputPath)),
    ensureDir(path.dirname(paths.projectYamlPath)),
    ensureDir(paths.premiseDir),
    ensureDir(paths.summaryDir),
    ensureDir(paths.outlineDir),
    ensureDir(paths.chapterDir),
    ensureDir(paths.globalRevisionDir),
    ensureDir(paths.plannerDir),
    ensureDir(paths.exportDir),
    ensureDir(path.join(paths.projectDir, "logs")),
  ]);
}

export function buildInitialManifest(args: {
  projectId: string;
  userInput: UserInput;
  runtime: RuntimeConfig;
  nowIso?: string;
}): ProjectManifest {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const initialTitle = args.userInput.bookTitle.trim() || "Untitled Novel";
  return {
    projectId: args.projectId,
    bookTitle: initialTitle,
    author: args.userInput.author,
    language: args.userInput.language,
    createdAt: nowIso,
    updatedAt: nowIso,
    checkpoints: {},
    activePointers: { outlineAttempt: 0, blocksAttempts: {}, chapterAttempts: {}, blockAttempts: {} },
    stageRuns: {},
    plannerDecisions: [],
    activePassPointers: {},
    runtime: args.runtime,
  };
}

export async function loadManifest(manifestPath: string): Promise<ProjectManifest> {
  const parsed = await readJsonFile<ProjectManifest>(manifestPath);
  const migrated = {
    ...parsed,
    stageRuns: parsed.stageRuns ?? {},
    plannerDecisions: parsed.plannerDecisions ?? [],
    activePassPointers: parsed.activePassPointers ?? {},
  };
  return ProjectManifestSchema.parse(migrated);
}

const manifestWriteQueue = new Map<string, Promise<void>>();

export async function saveManifest(manifestPath: string, manifest: ProjectManifest): Promise<void> {
  const previous = manifestWriteQueue.get(manifestPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    manifest.updatedAt = new Date().toISOString();
    await writeJsonAtomic(manifestPath, manifest);
  });

  manifestWriteQueue.set(manifestPath, next);
  try {
    await next;
  } finally {
    if (manifestWriteQueue.get(manifestPath) === next) manifestWriteQueue.delete(manifestPath);
  }
}

export function checkpointIdForStage(stageId: string): string {
  return `stage:${stageId}`;
}

export function checkpointIdForChapter(chapterNumber: number): string {
  return `stage:chapter_loop:${chapterKey(chapterNumber)}`;
}

export function checkpointIdForExportEpub(): string {
  return "export:epub";
}

export function setCheckpoint(manifest: ProjectManifest, id: string, status: CheckpointStatus, attempt: number, error?: string): void {
  manifest.checkpoints[id] = { status, attempt, updatedAt: new Date().toISOString(), error };
}

export function getCheckpointStatus(manifest: ProjectManifest, id: string): CheckpointStatus {
  return manifest.checkpoints[id]?.status ?? "pending";
}

export async function createStageAttemptFile(stageDir: string, payload: unknown): Promise<{ attempt: number; attemptPath: string; activePath: string }> {
  const attempt = await nextAttemptNumber(stageDir, "attempt", "dash");
  const attemptPath = path.join(stageDir, `attempt-${String(attempt).padStart(3, "0")}.json`);
  const activePath = path.join(stageDir, "active.json");
  await writeJsonAtomic(attemptPath, payload);
  await writeJsonAtomic(activePath, payload);
  return { attempt, attemptPath, activePath };
}

export async function createStageTextAttemptFile(stageDir: string, content: string): Promise<{ attempt: number; attemptPath: string; activePath: string }> {
  const attempt = await nextAttemptNumber(stageDir, "attempt", "dash");
  const attemptPath = path.join(stageDir, `attempt-${String(attempt).padStart(3, "0")}.md`);
  const activePath = path.join(stageDir, "active.md");
  await writeTextAtomic(attemptPath, content);
  await writeTextAtomic(activePath, content);
  return { attempt, attemptPath, activePath };
}

export async function createChapterPassFile(chapterRootDir: string, chapterNumber: number, pass: number, chapterMarkdown: string): Promise<{ activePath: string; passPath: string }> {
  const chDir = path.join(chapterRootDir, chapterKey(chapterNumber));
  const passesDir = path.join(chDir, "passes");
  await ensureDir(passesDir);
  const passPath = path.join(passesDir, `pass-${String(pass).padStart(3, "0")}.md`);
  const activePath = path.join(chDir, "chapter.active.md");
  await writeTextAtomic(passPath, chapterMarkdown);
  await writeTextAtomic(activePath, chapterMarkdown);
  return { activePath, passPath };
}

export function checkpointIdForLegacyBlock(chapterNumber: number, blockNumber: number): string {
  return `stage3:block:${chapterKey(chapterNumber)}:${blockKey(blockNumber)}`;
}
