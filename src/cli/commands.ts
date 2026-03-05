import { Command } from "commander";

import { loadConfigFromYaml } from "../config/index.js";
import {
  createAndRunProject,
  exportProjectEpub,
  getProjectStatus,
  listProjects,
  regenerateProject,
  resumeProject,
} from "../pipeline/service.js";
import { runInteractiveWizard } from "./wizard.js";

function parseIntOption(value: string | undefined, name: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name("ai-novelwriter")
    .description("CLI-first AI novel writer with resumable generation pipeline")
    .version("0.1.0")
    .option("--artifacts-root <path>", "Global artifacts root", ".artifacts/novels")
    .option("--model <model>", "Override model for all stages");

  program
    .command("new")
    .description("Start interactive wizard, save config, and run a new novel project")
    .action(async () => {
      const artifactsRoot = program.opts<{ artifactsRoot: string }>().artifactsRoot;
      const modelOverride = program.opts<{ model?: string }>().model;
      const config = await runInteractiveWizard(artifactsRoot);
      const result = await createAndRunProject({
        config,
        ...(modelOverride ? { modelOverride } : {}),
      });
      console.log(`Project created and generated: ${result.projectId}`);
      console.log(`Project directory: ${result.projectDir}`);
    });

  program
    .command("run")
    .description("Run a new project from a YAML config")
    .requiredOption("--config <path>", "Path to YAML config")
    .action(async (options: { config: string }) => {
      const artifactsRoot = program.opts<{ artifactsRoot: string }>().artifactsRoot;
      const modelOverride = program.opts<{ model?: string }>().model;
      const config = await loadConfigFromYaml(options.config);
      config.runtime.artifactsRoot = artifactsRoot;

      const result = await createAndRunProject({
        config,
        ...(modelOverride ? { modelOverride } : {}),
      });
      console.log(`Project created and generated: ${result.projectId}`);
      console.log(`Project directory: ${result.projectDir}`);
    });

  program
    .command("resume")
    .description("Resume an existing project from the first incomplete checkpoint")
    .requiredOption("--project-id <id>", "Project ID")
    .action(async (options: { projectId: string }) => {
      const artifactsRoot = program.opts<{ artifactsRoot: string }>().artifactsRoot;
      const modelOverride = program.opts<{ model?: string }>().model;
      await resumeProject({
        artifactsRoot,
        projectId: options.projectId,
        ...(modelOverride ? { modelOverride } : {}),
      });
      console.log(`Resumed project: ${options.projectId}`);
    });

  program
    .command("regen")
    .description("Regenerate targeted artifacts and resume downstream pipeline")
    .requiredOption("--project-id <id>", "Project ID")
    .requiredOption("--target <target>", "outline|blocks|chapter|block")
    .option("--chapter <number>", "Chapter number")
    .option("--block <number>", "Block number")
    .action(async (options: { projectId: string; target: string; chapter?: string; block?: string }) => {
      const artifactsRoot = program.opts<{ artifactsRoot: string }>().artifactsRoot;
      const modelOverride = program.opts<{ model?: string }>().model;
      const chapter = parseIntOption(options.chapter, "chapter");
      const block = parseIntOption(options.block, "block");

      if (!["outline", "blocks", "chapter", "block"].includes(options.target)) {
        throw new Error("target must be one of: outline, blocks, chapter, block");
      }

      await regenerateProject({
        artifactsRoot,
        projectId: options.projectId,
        target: options.target as "outline" | "blocks" | "chapter" | "block",
        ...(chapter ? { chapter } : {}),
        ...(block ? { block } : {}),
        ...(modelOverride ? { modelOverride } : {}),
      });

      console.log(`Regeneration complete for project ${options.projectId} target=${options.target}`);
    });

  const exportCmd = program.command("export").description("Export outputs");

  exportCmd
    .command("epub")
    .requiredOption("--project-id <id>", "Project ID")
    .description("Generate EPUB from active chapter markdown files")
    .action(async (options: { projectId: string }) => {
      const artifactsRoot = program.opts<{ artifactsRoot: string }>().artifactsRoot;
      const epubPath = await exportProjectEpub({
        artifactsRoot,
        projectId: options.projectId,
      });

      console.log(`EPUB generated: ${epubPath}`);
    });

  program
    .command("status")
    .description("Show checkpoint status for a project")
    .requiredOption("--project-id <id>", "Project ID")
    .action(async (options: { projectId: string }) => {
      const artifactsRoot = program.opts<{ artifactsRoot: string }>().artifactsRoot;
      const status = await getProjectStatus({ artifactsRoot, projectId: options.projectId });
      console.log(JSON.stringify(status, null, 2));
    });

  program
    .command("list")
    .description("List available project IDs")
    .action(async () => {
      const artifactsRoot = program.opts<{ artifactsRoot: string }>().artifactsRoot;
      const projects = await listProjects(artifactsRoot);
      if (projects.length === 0) {
        console.log("No projects found.");
        return;
      }

      for (const project of projects) {
        console.log(project);
      }
    });

  return program;
}
