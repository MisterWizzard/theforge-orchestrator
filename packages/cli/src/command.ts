/**
 * The contract every `forge` subcommand implements.
 *
 * Commands receive their environment and output sinks rather than reading
 * process globals, so the test suite can run them against a temporary
 * directory and read what they printed without spawning a process.
 */
export type CommandContext = {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Injected so `status` can be exercised without a coordinator listening. */
  fetch: typeof globalThis.fetch;
};

export type Command = {
  name: string;
  describe: string;
  /** Argument synopsis shown after the name in usage output. */
  usage?: string;
  /** Resolves to the process exit code. */
  run(argv: string[], ctx: CommandContext): Promise<number>;
};

/**
 * `--key=value` flags and bare `--flag` switches, the same shape the Tier 0
 * CLI accepts; everything else is positional.
 */
export function parseArgs(argv: string[]): {
  flags: Map<string, string | true>;
  positionals: string[];
} {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (const argument of argv) {
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator === -1) flags.set(argument.slice(2), true);
    else flags.set(argument.slice(2, separator), argument.slice(separator + 1));
  }
  return { flags, positionals };
}
