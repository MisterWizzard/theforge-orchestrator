import type { Command, CommandContext } from './command.js';

export type Registry = {
  commands: readonly Command[];
  run(argv: string[], ctx: CommandContext): Promise<number>;
};

export function createRegistry(commands: readonly Command[]): Registry {
  const byName = new Map(commands.map((command) => [command.name, command]));
  // Two commands answering to one name would be resolved by list order, which
  // is exactly the kind of quiet surprise an operator tool must not have.
  if (byName.size !== commands.length) {
    throw new Error('forge: duplicate command name in the registry');
  }
  const usage = (): string[] => [
    'usage: forge <command> [options]',
    '',
    ...commands.map(
      (command) =>
        `  ${`${command.name} ${command.usage ?? ''}`.trim().padEnd(26)} ${command.describe}`,
    ),
  ];
  return {
    commands,
    async run(argv, ctx) {
      const [name, ...rest] = argv;
      if (!name || name === 'help' || name === '--help' || name === '-h') {
        const asked = Boolean(name);
        for (const line of usage()) (asked ? ctx.stdout : ctx.stderr)(line);
        return asked ? 0 : 2;
      }
      const command = byName.get(name);
      if (!command) {
        ctx.stderr(`forge: unknown command '${name}'`);
        for (const line of usage()) ctx.stderr(line);
        return 2;
      }
      return command.run(rest, ctx);
    },
  };
}
