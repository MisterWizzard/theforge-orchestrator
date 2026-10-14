import { readHaltFile, writeHaltFile } from '@theforge/guardrails';
import { parseArgs, type Command } from '../command.js';
import { haltFilePath } from '../halt-file.js';

export const haltCommand: Command = {
  name: 'halt',
  describe: 'Stop leasing new work by writing the halt file; in-flight jobs finish',
  usage: '[--reason=text]',
  async run(argv, ctx) {
    const { flags } = parseArgs(argv);
    const reason = flags.get('reason');
    if (reason === true) {
      ctx.stderr('forge halt: --reason needs a value, for example --reason="disk nearly full"');
      return 2;
    }
    const path = haltFilePath(ctx.env);
    const previous = await readHaltFile(path);
    await writeHaltFile(path, {
      requestedAt: new Date().toISOString(),
      requestedBy: 'cli',
      ...(reason ? { reason } : {}),
    });
    if (previous.exists) {
      const since = previous.request
        ? ` since ${previous.request.requestedAt} (${previous.request.requestedBy})`
        : '';
      ctx.stdout(`already halted${since}; halt file rewritten: ${path}`);
    } else {
      ctx.stdout(`halted; halt file written: ${path}`);
    }
    if (reason) ctx.stdout(`reason: ${reason}`);
    ctx.stdout(
      'workers finish what they hold and receive nothing new; `pnpm forge resume` clears it',
    );
    return 0;
  },
};
