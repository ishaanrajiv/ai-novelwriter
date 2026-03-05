import { stdout } from "node:process";
import { clearScreenDown, moveCursor } from "node:readline";

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
}

const DEFAULT_BAR_WIDTH = 28;
const DEFAULT_CHECKPOINT_LIMIT = 6;

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
  private renderedLines = 0;

  constructor(options?: CliProgressOptions) {
    this.stream = options?.stream ?? stdout;
    this.isTTY = Boolean(this.stream.isTTY);
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
    });

    this.captureCheckpoint(event);

    if (this.isTTY) {
      this.renderTTY();
      return;
    }

    this.renderPlain(event);
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
    this.checkpointLogs.push(`${event.stepLabel}: ${event.checkpointPath} | ${checkpointUrl}`);
    if (this.checkpointLogs.length > this.checkpointLogLimit) {
      this.checkpointLogs.shift();
    }
  }

  private renderTTY(): void {
    const lines = this.buildSnapshotLines();

    if (this.renderedLines > 0) {
      moveCursor(this.stream, 0, -this.renderedLines);
      clearScreenDown(this.stream);
    }

    this.stream.write(`${lines.join("\n")}\n`);
    this.renderedLines = lines.length;
  }

  private buildSnapshotLines(): string[] {
    const lines: string[] = [];
    lines.push(this.color("Pipeline Progress", "1"));

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
      lines.push(this.color("Validate checkpoints:", "1"));
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
      this.stream.write(`  checkpoint: ${event.checkpointPath}\n`);
      this.stream.write(`  link: ${event.checkpointUrl ?? `file://${event.checkpointPath}`}\n`);
    }
  }

  private ratio(done: number, total: number, state: RenderableState): number {
    if (total <= 0) {
      return state === "complete" || state === "skipped" ? 1 : 0;
    }
    return Math.max(0, Math.min(1, done / total));
  }

  private renderBar(ratio: number): string {
    const filled = Math.round(ratio * this.barWidth);
    const empty = this.barWidth - filled;
    return `[${"#".repeat(filled)}${"-".repeat(empty)}]`;
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
}

export function createCliProgressReporter(options?: CliProgressOptions): PipelineProgressReporter {
  return new CliProgressRenderer(options);
}
