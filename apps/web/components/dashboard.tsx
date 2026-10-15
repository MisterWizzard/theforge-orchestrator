'use client';
import { useEffect, useState, type FormEvent } from 'react';
type Run = {
  id: string;
  objective: string;
  state: string;
  createdAt: string;
  spent: { usd: number; tokens: number };
};
type Diagnostic = {
  id: string;
  diagnostic: { available: boolean; authenticated: boolean; detail: string };
};
type Worker = {
  id: string;
  name: string;
  platform: string;
  status: string;
  capabilities: string[];
  lastHeartbeatAt: string;
};
type Project = {
  id: string;
  name: string;
  repositoryUrl: string;
  baseRef: string;
  checks: Array<{ executable: string; args: string[] }>;
};
type Approval = {
  id: string;
  runId: string;
  actionClass: string;
  normalizedAction: string;
  scope: string;
  status: string;
  expiresAt: string;
};
const api = '/forge-api';
export function Dashboard() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [providers, setProviders] = useState<Diagnostic[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [objective, setObjective] = useState(
    'Add a persisted notes feature with validation, tests, and a polished responsive UI.',
  );
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [targetBranch, setTargetBranch] = useState('main');
  const [checkCommand, setCheckCommand] = useState('pnpm check');
  const [maxUsd, setMaxUsd] = useState(5);
  const [maxTokens, setMaxTokens] = useState(100000);
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(120);
  const [autonomyProfile, setAutonomyProfile] = useState('standard');
  // Claude is the default for every role (ADR-024); Codex is an explicit choice.
  const [planner, setPlanner] = useState('claude');
  const [critic, setCritic] = useState('claude');
  const [builder, setBuilder] = useState('claude');
  const [reviewer, setReviewer] = useState('claude');
  const [busy, setBusy] = useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () =>
      void Promise.all([
        fetch(`${api}/runs`).then(requireJson<Run[]>),
        fetch(`${api}/providers`).then(requireJson<Diagnostic[]>),
        fetch(`${api}/workers`).then(requireJson<Worker[]>),
        fetch(`${api}/projects`).then(requireJson<Project[]>),
        fetch(`${api}/approvals`).then(requireJson<Approval[]>),
      ])
        .then(([nextRuns, nextProviders, nextWorkers, nextProjects, nextApprovals]) => {
          if (!active) return;
          setRuns(nextRuns);
          setProviders(nextProviders);
          setWorkers(nextWorkers);
          setProjects(nextProjects);
          // A selected project that the coordinator no longer lists would leave
          // the select blank while the URL input stayed disabled; fall back to
          // registering a new repository instead.
          setProjectId((current) =>
            current && !nextProjects.some((project) => project.id === current) ? '' : current,
          );
          setApprovals(nextApprovals);
          setConnected(true);
        })
        .catch(() => active && setConnected(false));
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function createRun(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const command = checkCommand.trim().split(/\s+/);
      if (!command[0]) throw new Error('At least one verification command is required');
      // Without a selection, a repository that is already registered is reused
      // rather than minted again under a fresh id on every submit.
      const existingProject = projectId
        ? undefined
        : projects.find(
            (project) =>
              normaliseRepositoryUrl(project.repositoryUrl) ===
              normaliseRepositoryUrl(repositoryUrl),
          );
      const selectedProjectId = projectId || existingProject?.id || `project-${Date.now()}`;
      const projectResponse = await fetch(`${api}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: selectedProjectId,
          name:
            repositoryUrl
              .split(/[\\/]/)
              .pop()
              ?.replace(/\.git$/, '') ?? selectedProjectId,
          repositoryUrl,
          baseRef: targetBranch,
          checks: [{ executable: command[0], args: command.slice(1) }],
        }),
      });
      if (!projectResponse.ok) throw new Error('Repository registration failed');
      const registeredProject = await requireJson<Project>(projectResponse);
      setProjects((current) =>
        current.some((project) => project.id === registeredProject.id)
          ? current.map((project) =>
              project.id === registeredProject.id ? registeredProject : project,
            )
          : [...current, registeredProject],
      );
      const response = await fetch(`${api}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedProjectId,
          objective,
          constraints: ['Preserve security policy'],
          maxUsd,
          maxTokens,
          configuration: {
            autonomyProfile,
            timeLimitMinutes,
            targetBranch,
            providerRoles: { planner, critic, builder, reviewer },
          },
        }),
      });
      const created = await requireJson<{ run: Run }>(response);
      setRuns((current) => [created.run, ...current]);
      const started = await fetch(`${api}/runs/${created.run.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!started.ok) throw new Error('Run start failed');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Run creation failed');
    } finally {
      setBusy(false);
    }
  }
  async function decideApproval(id: string, decision: 'approved' | 'rejected') {
    setDecidingApprovalId(id);
    setError('');
    try {
      const response = await fetch(`${api}/approvals/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const body = (await response.json()) as {
        approval?: { status?: string };
        error?: string;
      };
      if (!response.ok) {
        if (body.approval?.status === 'approved') {
          setApprovals((current) => current.filter((approval) => approval.id !== id));
          throw new Error(`Approval recorded; integration is blocked: ${body.error ?? 'unknown'}`);
        }
        throw new Error(`Approval decision failed with ${response.status}`);
      }
      setApprovals((current) => current.filter((approval) => approval.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approval decision failed');
    } finally {
      setDecidingApprovalId('');
    }
  }
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">CONTROL CENTRE</p>
          <h1>Build runs</h1>
        </div>
        <div className={`status ${connected ? 'good' : 'warn'}`}>
          <span />
          {connected ? 'Live' : 'Offline'}
        </div>
      </header>
      <div className="content">
        <section className="hero">
          <div>
            <span className="kicker">Objective → evidence</span>
            <h2>
              Give the work a clear outcome.
              <br />
              TheForge handles the handoffs.
            </h2>
            <p>
              Plan, critique, build, review and verify across Claude, Codex and your private
              workers—with every decision durable and inspectable.
            </p>
          </div>
          <form className="newRun" onSubmit={createRun}>
            <label htmlFor="objective">What should be completed?</label>
            <select
              aria-label="Existing project"
              value={projectId}
              onChange={(event) => {
                const value = event.target.value;
                setProjectId(value);
                const project = projects.find((item) => item.id === value);
                if (project) {
                  setRepositoryUrl(project.repositoryUrl);
                  setTargetBranch(project.baseRef);
                  const check = project.checks[0];
                  if (check) setCheckCommand([check.executable, ...check.args].join(' '));
                }
              }}
            >
              <option value="">Register a new repository</option>
              {projects.map((project) => (
                <option value={project.id} key={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <input
              id="repository"
              value={repositoryUrl}
              onChange={(event) => setRepositoryUrl(event.target.value)}
              placeholder="Repository URL"
              aria-label="Repository URL"
              required={!projectId}
              disabled={Boolean(projectId)}
            />
            <textarea
              id="objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              minLength={3}
            />
            <div className="formGrid">
              <label>
                Target branch
                <input
                  value={targetBranch}
                  onChange={(event) => setTargetBranch(event.target.value)}
                />
              </label>
              <label>
                Required check
                <input
                  value={checkCommand}
                  onChange={(event) => setCheckCommand(event.target.value)}
                />
              </label>
              <label>
                USD limit
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={maxUsd}
                  onChange={(event) => setMaxUsd(Number(event.target.value))}
                />
              </label>
              <label>
                Token limit
                <input
                  type="number"
                  min="0"
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(Number(event.target.value))}
                />
              </label>
              <label>
                Time limit (minutes)
                <input
                  type="number"
                  min="1"
                  max="1440"
                  value={timeLimitMinutes}
                  onChange={(event) => setTimeLimitMinutes(Number(event.target.value))}
                />
              </label>
              <label>
                Autonomy
                <select
                  value={autonomyProfile}
                  onChange={(event) => setAutonomyProfile(event.target.value)}
                >
                  <option value="cautious">Cautious</option>
                  <option value="standard">Standard</option>
                  <option value="high">High</option>
                </select>
              </label>
              {(
                [
                  ['Planner', planner, setPlanner],
                  ['Critic', critic, setCritic],
                  ['Builder', builder, setBuilder],
                  ['Reviewer', reviewer, setReviewer],
                ] as const
              ).map(([label, value, setter]) => (
                <label key={label}>
                  {label}
                  <select value={value} onChange={(event) => setter(event.target.value)}>
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                  </select>
                </label>
              ))}
            </div>
            <div className="formFoot">
              <span>
                ${maxUsd} cap · {timeLimitMinutes} min · strict checks
              </span>
              <button disabled={busy}>
                {busy ? 'Starting…' : 'Ignite run'} <b>→</b>
              </button>
            </div>
            {error ? <p role="alert">{error}</p> : null}
          </form>
        </section>
        <section className="stats" aria-label="Run summary">
          <Metric
            value={String(
              runs.filter((r) => !['completed', 'failed', 'cancelled'].includes(r.state)).length,
            )}
            label="Active runs"
            note="Across all projects"
          />
          <Metric
            value={String(runs.filter((r) => r.state === 'completed').length)}
            label="Verified"
            note="Acceptance passed"
          />
          <Metric
            value={
              providers.filter((p) => p.id !== 'fake' && p.diagnostic.authenticated).length +
              '/' +
              '2'
            }
            label="Providers ready"
            note="Automatic fallback"
          />
          <Metric
            value={'$' + runs.reduce((n, r) => n + r.spent.usd, 0).toFixed(2)}
            label="Current spend"
            note="All runs"
          />
        </section>
        <section className="panel">
          <div className="sectionHead">
            <div>
              <p className="eyebrow">RECENT ACTIVITY</p>
              <h3>Runs</h3>
            </div>
            <div className="legend">
              <i className="running" />
              Running <i className="complete" />
              Complete <i className="blocked" />
              Needs input
            </div>
          </div>
          {runs.length ? (
            <div className="runList">
              {runs.map((run) => (
                <a className="run" href={`/runs/${run.id}`} key={run.id}>
                  <span className={`runIcon ${run.state}`}>✦</span>
                  <span className="runMain">
                    <b>{run.objective}</b>
                    <small>
                      {new Date(run.createdAt).toLocaleString()} · {run.id.slice(0, 8)}
                    </small>
                  </span>
                  <span className="state">{run.state.replaceAll('_', ' ')}</span>
                  <span className="cost">${run.spent.usd.toFixed(2)}</span>
                  <span className="arrow">›</span>
                </a>
              ))}
            </div>
          ) : (
            <div className="empty">
              <span>◇</span>
              <h4>No runs yet</h4>
              <p>
                Your first objective is loaded above. Ignite it when the coordinator is running.
              </p>
            </div>
          )}
        </section>
        <section className="panel" id="approvals">
          <div className="sectionHead">
            <div>
              <p className="eyebrow">EXACT ACTION GATES</p>
              <h3>Approval inbox</h3>
            </div>
          </div>
          {approvals.length ? (
            approvals.map((approval) => (
              <div className="diagnostic" key={approval.id}>
                <div>
                  <b>{approval.actionClass} action</b>
                  <small>
                    Run {approval.runId.slice(0, 8)} · expires{' '}
                    {new Date(approval.expiresAt).toLocaleString()}
                  </small>
                  <code>{approval.normalizedAction}</code>
                  <code>{approval.scope}</code>
                </div>
                <div className="approvalActions">
                  <button
                    disabled={decidingApprovalId === approval.id}
                    onClick={() => decideApproval(approval.id, 'rejected')}
                    aria-label={`Reject action for run ${approval.runId.slice(0, 8)}`}
                  >
                    Reject
                  </button>
                  <button
                    disabled={decidingApprovalId === approval.id}
                    onClick={() => decideApproval(approval.id, 'approved')}
                    aria-label={`Approve action for run ${approval.runId.slice(0, 8)}`}
                  >
                    Approve
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="muted">No actions are waiting for approval.</p>
          )}
        </section>
        <section className="lower">
          <div className="panel" id="providers">
            <div className="sectionHead">
              <div>
                <p className="eyebrow">PROVIDER HEALTH</p>
                <h3>Model adapters</h3>
              </div>
            </div>
            {providers.length ? (
              providers.map((provider) => (
                <div className="diagnostic" key={provider.id}>
                  <b>{provider.id}</b>
                  <span className={provider.diagnostic.authenticated ? 'ok' : 'muted'}>
                    {provider.diagnostic.detail}
                  </span>
                </div>
              ))
            ) : (
              <p className="muted">
                Start the coordinator to inspect Claude and Codex authentication.
              </p>
            )}
          </div>
          <div className="panel" id="workers">
            <div className="sectionHead">
              <div>
                <p className="eyebrow">PRIVATE NETWORK</p>
                <h3>Workers</h3>
              </div>
            </div>
            {workers.length ? (
              workers.map((worker) => (
                <div className="diagnostic" key={worker.id}>
                  <b>
                    {worker.name} · {worker.platform}
                  </b>
                  <span className={worker.status === 'online' ? 'ok' : 'muted'}>
                    {worker.status} · {worker.capabilities.join(', ')} ·{' '}
                    {new Date(worker.lastHeartbeatAt).toLocaleTimeString()}
                  </span>
                </div>
              ))
            ) : (
              <div className="workerArt">
                <div className="orb">F</div>
                <p>Connect Linux and Windows workers over your private network.</p>
                <code>pnpm --filter @theforge/worker dev</code>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
async function requireJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return (await response.json()) as T;
}
/** Trailing separators are the only difference a pasted path or clone URL tends to carry. */
function normaliseRepositoryUrl(value: string): string {
  return value.trim().replace(/[\\/]+$/, '');
}
function Metric({ value, label, note }: { value: string; label: string; note: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
      <small>{note}</small>
    </div>
  );
}
