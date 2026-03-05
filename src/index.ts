#!/usr/bin/env node

import { buildCli } from "./cli/commands.js";

async function main(): Promise<void> {
  const cli = buildCli();
  await cli.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
