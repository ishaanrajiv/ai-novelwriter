import { stdout } from "node:process";

import type { PipelineProgressEvent, PipelineProgressReporter, PipelineStepState } from "../pipeline/service.js";

interface CliProgressOptions {
  stream?: NodeJS.WriteStream;
  barWidth?: number;
  checkpointLogLimit?: number;
}

type RenderableState = PipelineStepState | "pending";

interface StepSnapshot {
  stepLabel: string;
  stepIndex: number;
  stepCount: number;
  done: number;
  total: number;
  state: RenderableState;
  message: string;
  updatedAtMs: number;
}

const DEFAULT_BAR_WIDTH = 28;
const DEFAULT_CHECKPOINT_LIMIT = 6;
const SPINNER_FRAMES = ["|", "/", "-", "\\"];

const FALLBACK_STEP_LABELS = new Map<number, string>([
  [1, "Outline"],
  [2, "Story Blocks"],
  [3, "Chapter Drafts"],
  [4, "EPUB Export"],
]);

class CliProgressRenderer implements PipelineProgressReporter {
  private readonly stream: NodeJS.WriteStream;
  private readonly isTTY: boolean;
  private readonly barWidth: number;
  private readonly checkpointLogLimit: number;
  private readonly steps = new Map<number, StepSnapshot>();
  private readonly checkpointKeys = new Set<string>();
  private readonly checkpointLogs: string[] = [];
  private readonly startedAtMs = Date.now();
  private renderedLines = 0;
  private spinnerIndex = 0;
  private frameHash = "";
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: CliProgressOptions) {
    this.stream = options?.stream ?? stdout;
    this.isTTY = Boolean(this.stream.isTTY) && process.env.TERM !== "dumb";
    this.barWidth = options?.barWidth ?? DEFAULT_BAR_WIDTH;
    this.checkpointLogLimit = options?.checkpointLogLimit ?? DEFAULT_CHECKPOINT_LIMIT;
  }

  onProgress(event: PipelineProgressEvent): void {
    this.ensureStepSlots(event.stepCount);
    this.steps.set(event.stepIndex, {
      stepLabel: event.stepLabel,
      stepIndex: event.stepIndex,
      stepCount: event.stepCount,
      done: event.done,
      total: event.total,
      state: event.state,
      message: event.message,
      updatedAtMs: Date.now(),
    });

    this.captureCheckpoint(event);
    this.render(event);
  }

  private ensureStepSlots(stepCount: number): void {
    for (let stepIndex = 1; stepIndex <= stepCount; stepIndex += 1) {
      if (this.steps.has(stepIndex)) {
        continue;
      }

      this.steps.set(stepIndex, {
        stepLabel: FALLBACK_STEP_LABELS.get(stepIndex) ?? `Step ${stepIndex}`,
        stepIndex,
        stepCount,
        done: 0,
        total: 1,
        state: "pending",
        message: "Waiting...",
        updatedAtMs: this.startedAtMs,
      });
    }
  }

  private captureCheckpoint(event: PipelineProgressEvent): void {
    if (!event.checkpointPath) {
      return;
    }

    const key = `${event.stepIndex}:${event.checkpointPath}`;
    if (this.checkpointKeys.has(key)) {
      return;
    }

    this.checkpointKeys.add(key);
    const checkpointUrl = event.checkpointUrl ?? `file://${event.checkpointPath}`;
    this.checkpointLogs.push(`${event.stepLabel}: ${checkpointUrl}`);
    if (this.checkpointLogs.length > this.checkpointLogLimit) {
      this.checkpointLogs.shift();
    }
  }

  private render(event: PipelineProgressEvent): void {
    if (!this.isTTY) {
      this.renderPlain(event);
      return;
    }

    this.renderTTY();
    this.syncAnimation();
  }

  private syncAnimation(): void {
    const hasRunningStep = [...this.steps.values()].some((step) => step.state === "in_progress");
    if (hasRunningStep && !this.tickTimer) {
      this.tickTimer = setInterval(() => {
        this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
        this.renderTTY();
      }, 90);
      return;
    }

    if (!hasRunningStep && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private renderTTY(): void {
    const lines = this.buildSnapshotLines();
    const frameHash = lines.join("\n");
    if (frameHash === this.frameHash) {
      return;
    }

    if (this.renderedLines > 0) {
      this.stream.write(`\u001b[${this.renderedLines}A\r\u001b[J`);
    }

    this.stream.write(`${lines.join("\n")}\n`);
    this.renderedLines = lines.length;
    this.frameHash = frameHash;
  }

  private buildSnapshotLines(): string[] {
    const lines: string[] = [];
    const elapsed = this.formatDuration(Math.max(0, Date.now() - this.startedAtMs));
    const overall = this.overallRatio();
    const spinner = SPINNER_FRAMES[this.spinnerIndex] ?? "|";
    lines.push(
      `${this.color("Pipeline", "1")} ${spinner} ${this.renderBar(overall)} ${Math.round(overall * 100)
        .toString()
        .padStart(3, " ")}% ${this.color(`elapsed ${elapsed}`, "2")}`,
    );

    for (const step of [...this.steps.values()].sort((a, b) => a.stepIndex - b.stepIndex)) {
      const ratio = this.ratio(step.done, step.total, step.state);
      const status = this.statusLabel(step.state);
      const progressPct = `${Math.round(ratio * 100)}%`.padStart(4, " ");
      const bar = this.renderBar(ratio);
      const stateColor = this.stateColor(step.state);
      lines.push(
        `${this.color(`[${step.stepIndex}/${step.stepCount}]`, "2")} ${this.color(step.stepLabel.padEnd(14), "1")} ${this.color(bar, stateColor)} ${this.color(progressPct, stateColor)} ${this.color(status, stateColor)} ${step.message}`,
      );
    }

    if (this.checkpointLogs.length > 0) {
      lines.push("");
      lines.push(this.color("Latest checkpoints:", "1"));
      for (const checkpoint of this.checkpointLogs) {
        lines.push(`${this.color("-", "2")} ${checkpoint}`);
      }
    }

    return lines;
  }

  private renderPlain(event: PipelineProgressEvent): void {
    const ratio = this.ratio(event.done, event.total, event.state);
    const progressPct = `${Math.round(ratio * 100)}%`.padStart(4, " ");
    this.stream.write(`[${event.stepIndex}/${event.stepCount}] ${event.stepLabel} ${progressPct} ${event.message}\n`);
    if (event.checkpointPath) {
      this.stream.write(`  checkpoint: ${event.checkpointUrl ?? `file://${event.checkpointPath}`}\n`);
    }
  }

  private ratio(done: number, total: number, state: RenderableState): number {
    if (total <= 0) {
      return state === "complete" || state === "skipped" ? 1 : 0;
    }
    return Math.max(0, Math.min(1, done / total));
  }

  private renderBar(ratio: number): string {
    const safeRatio = Math.max(0, Math.min(1, ratio));
    const filled = Math.floor(safeRatio * this.barWidth);
    const hasHead = safeRatio > 0 && safeRatio < 1;
    const empty = this.barWidth - filled - (hasHead ? 1 : 0);
    return `[${"=".repeat(filled)}${hasHead ? ">" : ""}${".".repeat(Math.max(0, empty))}]`;
  }

  private statusLabel(state: RenderableState): string {
    if (state === "pending") {
      return "WAIT";
    }
    if (state === "in_progress") {
      return "RUN ";
    }
    if (state === "complete") {
      return "DONE";
    }
    if (state === "skipped") {
      return "SKIP";
    }
    return "FAIL";
  }

  private stateColor(state: RenderableState): string {
    if (state === "complete") {
      return "32";
    }
    if (state === "skipped") {
      return "33";
    }
    if (state === "failed") {
      return "31";
    }
    if (state === "pending") {
      return "2";
    }
    return "36";
  }

  private color(value: string, ansiCode: string): string {
    if (!this.isTTY) {
      return value;
    }
    return `\u001b[${ansiCode}m${value}\u001b[0m`;
  }

  private overallRatio(): number {
    if (this.steps.size === 0) {
      return 0;
    }

    const values = [...this.steps.values()];
    const sum = values.reduce((acc, step) => acc + this.ratio(step.done, step.total, step.state), 0);
    return sum / values.length;
  }

  private formatDuration(durationMs: number): string {
    const totalSeconds = Math.floor(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
}

export function createCliProgressReporter(options?: CliProgressOptions): PipelineProgressReporter {
  return new CliProgressRenderer(options);
}
