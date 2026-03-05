#!/usr/bin/env node

import { buildCli } from "./cli/commands.js";
import { bootstrapEnvironment } from "./env/bootstrap.js";

async function main(): Promise<void> {
  await bootstrapEnvironment();
  const cli = buildCli();
  await cli.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
