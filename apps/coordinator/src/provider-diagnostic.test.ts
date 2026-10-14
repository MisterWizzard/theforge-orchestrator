import { describe, expect, it } from 'vitest';
import type { Worker } from '@theforge/contracts';
import { providerAvailability } from './provider-diagnostic.js';

function worker(overrides: Partial<Worker> & { id: string }): Worker {
  return {
    name: overrides.id,
    platform: 'win32',
    capabilities: ['git'],
    policyProfile: 'default',
    status: 'online',
    lastHeartbeatAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

const online = (w: Worker) => w.status === 'online';

const WORKSPACE_FAULT =
  'the API key was rejected (HTTP 400): This API key is not scoped to a workspace';

describe('providerAvailability (ADR-038)', () => {
  it('is available and authenticated when an online worker advertises the provider', () => {
    const result = providerAvailability(
      'claude',
      [worker({ id: 'w1', name: 'NODEE', capabilities: ['git', 'provider:claude'] })],
      online,
    );
    expect(result).toEqual({
      available: true,
      authenticated: true,
      detail: 'claude is available on worker NODEE',
    });
  });

  it('says why when a worker is configured for the provider but proved the key broken', () => {
    const result = providerAvailability(
      'claude',
      [
        worker({
          id: 'w1',
          name: 'NODEE',
          capabilities: ['git', 'provider:codex'],
          providerFaults: { claude: WORKSPACE_FAULT },
        }),
      ],
      online,
    );
    // The CLI is there but the credential is not usable: available, not authenticated.
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.detail).toBe(
      `claude is configured on worker NODEE but does not work: ${WORKSPACE_FAULT}`,
    );
  });

  it('prefers a working worker over a faulty one', () => {
    const result = providerAvailability(
      'claude',
      [
        worker({ id: 'bad', name: 'bad', providerFaults: { claude: WORKSPACE_FAULT } }),
        worker({ id: 'good', name: 'good', capabilities: ['provider:claude'] }),
      ],
      online,
    );
    expect(result).toMatchObject({ available: true, authenticated: true });
    expect(result.detail).toContain('good');
  });

  it('is not available when no online worker has it or reports a fault', () => {
    expect(providerAvailability('claude', [], online)).toEqual({
      available: false,
      authenticated: false,
      detail: 'No online worker advertises provider:claude',
    });
    // A fault on a different provider says nothing about this one.
    expect(
      providerAvailability(
        'claude',
        [worker({ id: 'w1', providerFaults: { codex: 'not logged in' } })],
        online,
      ),
    ).toMatchObject({ available: false, authenticated: false });
  });

  it('ignores workers that are offline, capable or faulty', () => {
    const offline = (overrides: Partial<Worker>) =>
      worker({ id: 'off', status: 'offline', ...overrides });
    expect(
      providerAvailability('claude', [offline({ capabilities: ['provider:claude'] })], online),
    ).toMatchObject({ available: false });
    expect(
      providerAvailability('claude', [offline({ providerFaults: { claude: 'x' } })], online),
    ).toMatchObject({ available: false });
  });
});
