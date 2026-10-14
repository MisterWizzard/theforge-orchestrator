import { resolveHaltFilePath } from '@theforge/guardrails';

/**
 * The same resolution the coordinator performs, fed from the same variables,
 * so `pnpm forge halt` and the coordinator name one file. Relative values are
 * resolved against this process's working directory - which is why the
 * documented advice is an absolute FORGE_HALT_FILE.
 */
export const haltFilePath = (env: Record<string, string | undefined>): string =>
  resolveHaltFilePath({ workspaceRoot: env.FORGE_WORKSPACE_ROOT, haltFile: env.FORGE_HALT_FILE });
