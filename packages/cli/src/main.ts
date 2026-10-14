#!/usr/bin/env node
/**
 * `forge`: operator commands for TheForge.
 *
 * Run from the repository root as `pnpm forge <command>`, which loads `.env`
 * first. Commands live in src/commands and are listed in src/commands/index.ts;
 * this file only wires that list to the process.
 */
import { commands } from './commands/index.js';
import { createRegistry } from './registry.js';

try {
  process.exitCode = await createRegistry(commands).run(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    fetch: globalThis.fetch,
  });
} catch (error) {
  console.error(`forge: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
