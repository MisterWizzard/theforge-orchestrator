import { resolve } from 'node:path';
import { checkHalt, readHaltFile } from '@theforge/guardrails';
import type { Command, CommandContext } from '../command.js';
import { haltFilePath } from '../halt-file.js';

export type Fetched = { ok: true; status: number; body: unknown } | { ok: false; error: string };

export async function fetchJson(
  ctx: CommandContext,
  url: string,
  headers: Record<string, string> = {},
): Promise<Fetched> {
  try {
    const response = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON; report the raw text instead.
    }
    return { ok: true, status: response.status, body };
  } catch (error) {
    // Node wraps connection failures as "fetch failed" with the useful part
    // (ECONNREFUSED and friends) on `cause`.
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: cause ? `${message}: ${cause}` : message };
  }
}

export const field = (body: unknown, key: string): unknown =>
  body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;

export const statusCommand: Command = {
  name: 'status',
  describe:
    'Report the halt file, plus /health and /api/halt when FORGE_API_URL and FORGE_COORDINATOR_TOKEN are set',
  async run(_argv, ctx) {
    const path = haltFilePath(ctx.env);
    const file = await readHaltFile(path);
    const verdict = checkHalt({ fileExists: file.exists });
    ctx.stdout(`halted: ${verdict.halted ? 'yes' : 'no'}`);
    ctx.stdout(`halt file: ${path}${file.exists ? '' : ' (absent)'}`);
    if (file.request) {
      ctx.stdout(`requested: ${file.request.requestedAt} by ${file.request.requestedBy}`);
      if (file.request.reason) ctx.stdout(`reason: ${file.request.reason}`);
    } else if (file.exists) {
      ctx.stdout('the halt file carries no request body (made by hand); it halts all the same');
    }

    const apiUrl = ctx.env.FORGE_API_URL;
    const token = ctx.env.FORGE_COORDINATOR_TOKEN;
    if (!apiUrl || !token) {
      ctx.stdout(
        'coordinator: not queried (set FORGE_API_URL and FORGE_COORDINATOR_TOKEN to include it)',
      );
      return 0;
    }
    const base = apiUrl.replace(/\/+$/, '');
    const health = await fetchJson(ctx, `${base}/health`);
    if (!health.ok) {
      ctx.stdout(`coordinator: unreachable at ${base} (${health.error})`);
      return 0;
    }
    const healthStatus = field(health.body, 'status');
    ctx.stdout(
      `coordinator health: ${typeof healthStatus === 'string' ? healthStatus : `HTTP ${health.status}`}`,
    );

    const halt = await fetchJson(ctx, `${base}/api/halt`, { authorization: `Bearer ${token}` });
    if (!halt.ok) {
      ctx.stdout(`coordinator halt: unreachable (${halt.error})`);
      return 0;
    }
    if (halt.status !== 200) {
      ctx.stdout(`coordinator halt: HTTP ${halt.status} ${JSON.stringify(halt.body)}`);
      return 0;
    }
    const halted = field(halt.body, 'halted') === true;
    const source = field(halt.body, 'source');
    ctx.stdout(
      `coordinator halted: ${halted ? 'yes' : 'no'}${halted && typeof source === 'string' ? ` (source: ${source})` : ''}`,
    );
    const remote = field(halt.body, 'haltFile');
    if (typeof remote === 'string') {
      ctx.stdout(`coordinator halt file: ${remote}`);
      // Same machine, different answer means one side was started from a
      // different directory: a halt from here would not be seen there.
      if (resolve(remote) !== resolve(path)) {
        ctx.stderr(
          'warning: the coordinator resolves the halt file to a different path than this CLI; ' +
            'set FORGE_HALT_FILE to an absolute path in .env so they agree',
        );
      }
    }
    return 0;
  },
};
