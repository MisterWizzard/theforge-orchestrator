import { afterAll, describe, expect, it } from 'vitest';

/**
 * The coordinator reads its configuration once, at import, so the memory floor
 * is set here before `server.ts` is loaded and this file gets its own
 * coordinator (and, under DATABASE_URL, its own schema). A floor of 1 TiB is
 * above any free-memory reading a real host can produce, which turns the
 * floor into a deterministic refusal without touching os.freemem(): the point
 * is that FORGE_MIN_FREE_MEMORY_MB reaches the lease path and is honoured, not
 * how much memory this machine happens to have.
 */
process.env.FORGE_MIN_FREE_MEMORY_MB = '1048576';
const { app } = await import('./server.js');

afterAll(async () => {
  await app.close();
});

describe('lease guard', () => {
  it('refuses to lease below the free-memory floor with a reason header, and logs once', async () => {
    const registration = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: 'memory-floor-worker',
        name: 'memory floor fixture',
        platform: 'linux',
        capabilities: ['memory-floor-fixture'],
        policyProfile: 'default',
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const { sessionToken } = registration.json<{ sessionToken: string }>();
    const lease = () =>
      app.inject({
        method: 'GET',
        url: '/api/workers/memory-floor-worker/jobs/next',
        headers: { authorization: `Bearer ${sessionToken}` },
      });
    // 204, not an error: the worker keeps polling and will be handed work as
    // soon as memory frees, exactly as it does across a halt.
    const refused = await lease();
    expect(refused.statusCode, refused.body).toBe(204);
    expect(refused.headers['x-forge-lease-refused']).toMatch(
      /^min-free-memory \(\d+ MB < 1048576 MB\)$/,
    );
    expect(refused.headers['x-forge-halted']).toBeUndefined();
    // Stable across polls: the floor is evaluated on every lease, never cached
    // into a "refused" state that a later poll could inherit by mistake.
    const again = await lease();
    expect(again.statusCode).toBe(204);
    expect(again.headers['x-forge-lease-refused']).toMatch(/^min-free-memory/);
  });
});
