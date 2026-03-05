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
  outlineDir: string;
  blocksDir: string;
  chapterDir: string;
  exportDir: string;
}

export function getProjectPaths(artifactsRootAbs: string, projectId: string): ProjectPaths {
  const projectDir = path.join(artifactsRootAbs, projectId);
  return {
    projectDir,
    manifestPath: path.join(projectDir, "manifest.json"),
    inputPath: path.join(projectDir, "inputs", "user-input.json"),
    projectYamlPath: path.join(projectDir, "project.yaml"),
    outlineDir: path.join(projectDir, "stage1-outline"),
    blocksDir: path.join(projectDir, "stage2-blocks"),
    chapterDir: path.join(projectDir, "stage3-chapters"),
    exportDir: path.join(projectDir, "exports", "epub"),
  };
}

export async function initProjectDirs(paths: ProjectPaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.projectDir),
    ensureDir(path.dirname(paths.inputPath)),
    ensureDir(path.dirname(paths.projectYamlPath)),
    ensureDir(paths.outlineDir),
    ensureDir(paths.blocksDir),
    ensureDir(paths.chapterDir),
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
    activePointers: {
      outlineAttempt: 0,
      blocksAttempts: {},
      chapterAttempts: {},
      blockAttempts: {},
    },
    runtime: args.runtime,
  };
}

export async function loadManifest(manifestPath: string): Promise<ProjectManifest> {
  const parsed = await readJsonFile<ProjectManifest>(manifestPath);
  return ProjectManifestSchema.parse(parsed);
}

export async function saveManifest(manifestPath: string, manifest: ProjectManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  await writeJsonAtomic(manifestPath, manifest);
}

export function checkpointIdForOutline(): string {
  return "stage1:outline";
}

export function checkpointIdForBlocks(chapterNumber: number): string {
  return `stage2:blocks:${chapterKey(chapterNumber)}`;
}

export function checkpointIdForBlock(chapterNumber: number, blockNumber: number): string {
  return `stage3:block:${chapterKey(chapterNumber)}:${blockKey(blockNumber)}`;
}

export function checkpointIdForChapter(chapterNumber: number): string {
  return `stage3:chapter:${chapterKey(chapterNumber)}`;
}

export function checkpointIdForExportEpub(): string {
  return "export:epub";
}

export function setCheckpoint(
  manifest: ProjectManifest,
  id: string,
  status: CheckpointStatus,
  attempt: number,
  error?: string,
): void {
  manifest.checkpoints[id] = {
    status,
    attempt,
    updatedAt: new Date().toISOString(),
    error,
  };
}

export function getCheckpointStatus(manifest: ProjectManifest, id: string): CheckpointStatus {
  return manifest.checkpoints[id]?.status ?? "pending";
}

export async function createOutlineAttemptFile(
  outlineDir: string,
  content: unknown,
): Promise<{ attempt: number; attemptPath: string; activePath: string }> {
  const attempt = await nextAttemptNumber(outlineDir, "attempt", "dash");
  const attemptFile = `attempt-${String(attempt).padStart(3, "0")}.json`;
  const attemptPath = path.join(outlineDir, attemptFile);
  const activePath = path.join(outlineDir, "active.json");
  await writeJsonAtomic(attemptPath, content);
  await writeJsonAtomic(activePath, content);
  return { attempt, attemptPath, activePath };
}

export async function createBlocksAttemptFile(
  blocksDir: string,
  chapterNumber: number,
  content: unknown,
): Promise<{ attempt: number; attemptPath: string; activePath: string }> {
  const ck = chapterKey(chapterNumber);
  const attempt = await nextAttemptNumber(blocksDir, ck);
  const attemptName = `${ck}.attempt-${String(attempt).padStart(3, "0")}.json`;
  const activeName = `${ck}.active.json`;
  const attemptPath = path.join(blocksDir, attemptName);
  const activePath = path.join(blocksDir, activeName);
  await writeJsonAtomic(attemptPath, content);
  await writeJsonAtomic(activePath, content);
  return { attempt, attemptPath, activePath };
}

export async function createChapterBlockAttemptFile(
  chapterRootDir: string,
  chapterNumber: number,
  blockNumber: number,
  content: unknown,
): Promise<{ attempt: number; attemptPath: string; activePath: string; chapterDir: string }> {
  const chDir = path.join(chapterRootDir, chapterKey(chapterNumber));
  await ensureDir(chDir);

  const bk = blockKey(blockNumber);
  const attempt = await nextAttemptNumber(chDir, bk);
  const attemptName = `${bk}.attempt-${String(attempt).padStart(3, "0")}.json`;
  const activeName = `${bk}.active.json`;
  const attemptPath = path.join(chDir, attemptName);
  const activePath = path.join(chDir, activeName);

  await writeJsonAtomic(attemptPath, content);
  await writeJsonAtomic(activePath, content);

  return { attempt, attemptPath, activePath, chapterDir: chDir };
}

export async function createChapterAttemptFile(
  chapterRootDir: string,
  chapterNumber: number,
  chapterMarkdown: string,
): Promise<{ attempt: number; attemptPath: string; activePath: string; chapterDir: string }> {
  const chDir = path.join(chapterRootDir, chapterKey(chapterNumber));
  await ensureDir(chDir);
  const attempt = await nextAttemptNumber(chDir, "chapter");
  const attemptName = `chapter.attempt-${String(attempt).padStart(3, "0")}.md`;
  const activeName = "chapter.active.md";
  const attemptPath = path.join(chDir, attemptName);
  const activePath = path.join(chDir, activeName);

  await writeTextAtomic(attemptPath, chapterMarkdown);
  await writeTextAtomic(activePath, chapterMarkdown);

  return { attempt, attemptPath, activePath, chapterDir: chDir };
}
