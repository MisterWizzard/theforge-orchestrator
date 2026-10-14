import { removeHaltFile } from '@theforge/guardrails';
import type { Command } from '../command.js';
import { haltFilePath } from '../halt-file.js';

export const resumeCommand: Command = {
  name: 'resume',
  describe: 'Remove the halt file so the coordinator leases work again',
  async run(_argv, ctx) {
    const path = haltFilePath(ctx.env);
    const removed = await removeHaltFile(path);
    ctx.stdout(
      removed ? `resumed; halt file removed: ${path}` : `not halted; no halt file at ${path}`,
    );
    return 0;
  },
};
