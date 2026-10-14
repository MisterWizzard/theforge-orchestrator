'use client';

import { useEffect, useState } from 'react';

type Provider = {
  id: string;
  diagnostic: { available: boolean; authenticated: boolean; detail: string };
};
type Worker = {
  id: string;
  name: string;
  status: string;
  capabilities: string[];
};

export function SettingsPanel() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [health, setHealth] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    void Promise.allSettled([
      fetch('/forge-api/providers').then(readJson<Provider[]>),
      fetch('/forge-api/workers').then(readJson<Worker[]>),
      fetch('/forge-api/health').then(readJson<{ checks?: Record<string, string> }>),
    ]).then(([providerResult, workerResult, healthResult]) => {
      if (providerResult.status === 'fulfilled') setProviders(providerResult.value);
      if (workerResult.status === 'fulfilled') setWorkers(workerResult.value);
      if (healthResult.status === 'fulfilled') setHealth(healthResult.value.checks ?? {});
      if (
        providerResult.status === 'rejected' ||
        workerResult.status === 'rejected' ||
        healthResult.status === 'rejected'
      ) {
        setError('Some readiness checks are unavailable; available sections remain current.');
      }
    });
  }, []);
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">LOCAL CONTROL PLANE</p>
          <h1>Settings and readiness</h1>
        </div>
      </header>
      <div className="content">
        {error ? <p role="alert">{error}</p> : null}
        <section className="lower">
          <div className="panel">
            <h3>Dependencies</h3>
            {Object.entries(health).map(([name, state]) => (
              <div className="diagnostic" key={name}>
                <b>{name}</b>
                <span className={state === 'ok' ? 'ok' : 'muted'}>{state}</span>
              </div>
            ))}
          </div>
          <div className="panel">
            <h3>Provider workers</h3>
            {providers.map((provider) => (
              <div className="diagnostic" key={provider.id}>
                <b>{provider.id}</b>
                <span className={provider.diagnostic.authenticated ? 'ok' : 'muted'}>
                  {provider.diagnostic.detail}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <h3>Registered workers</h3>
          {workers.map((worker) => (
            <div className="diagnostic" key={worker.id}>
              <b>{worker.name}</b>
              <span className={worker.status === 'online' ? 'ok' : 'muted'}>
                {worker.status} · {worker.capabilities.join(', ')}
              </span>
            </div>
          ))}
          <p className="muted">
            Production command workers require the pinned Docker sandbox. Build it with{' '}
            <code>pnpm sandbox:build</code>, then start the worker with a stable{' '}
            <code>FORGE_WORKER_ID</code>. Tokens and provider credentials remain environment or
            OS-secret references and are never returned here.
          </p>
          <p className="muted">
            Provider/model roles, branch, checks, budgets, time limit and autonomy are selected per
            run on the Runs page. GitHub and provider credentials are configured only as local
            secret references; their values are never exposed in this UI. Amber integration and
            every Red action remain exact-scope approval gates.
          </p>
        </section>
      </div>
    </>
  );
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Readiness request failed with ${response.status}`);
  return (await response.json()) as T;
}
