import type { Worker } from '@theforge/contracts';

/**
 * What the coordinator can say about a worker-backed provider from the workers
 * it knows about (the `provider.diagnostic` event, `GET /api/providers`).
 *
 * Three answers, in this order:
 *   1. some online worker advertises `provider:<id>`: available and authenticated;
 *   2. an online worker is configured for it but proved the credential broken and
 *      withheld it (ADR-038): the CLI is there, the credential is not usable, and the
 *      worker's reason is relayed rather than "not found";
 *   3. nothing: no worker has it.
 *
 * Before ADR-038 only the first and last existed, and a configured-but-broken key
 * fell into the first because a key being present was enough to advertise.
 */
export type ProviderAvailability = {
  available: boolean;
  authenticated: boolean;
  detail: string;
};

export function providerAvailability(
  providerId: string,
  workers: Iterable<Worker>,
  isOnline: (worker: Worker) => boolean,
): ProviderAvailability {
  const online = [...workers].filter(isOnline);
  const capable = online.find((worker) => worker.capabilities.includes(`provider:${providerId}`));
  if (capable)
    return {
      available: true,
      authenticated: true,
      detail: `${providerId} is available on worker ${capable.name}`,
    };
  const faulty = online.find((worker) => worker.providerFaults?.[providerId]);
  if (faulty)
    return {
      available: true,
      authenticated: false,
      detail: `${providerId} is configured on worker ${faulty.name} but does not work: ${faulty.providerFaults?.[providerId]}`,
    };
  return {
    available: false,
    authenticated: false,
    detail: `No online worker advertises provider:${providerId}`,
  };
}
