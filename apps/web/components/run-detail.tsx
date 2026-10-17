'use client';
import { useEffect, useState } from 'react';
import { ApprovalAction } from './approval-action';
const api = '/forge-api';
type Detail = {
  run: {
    id: string;
    objective: string;
    state: string;
    budget: { maxUsd: number };
    spent: { usd: number };
    configuration?: {
      autonomyProfile: string;
      timeLimitMinutes: number;
      targetBranch: string;
      providerRoles: Record<string, string>;
    };
  };
  tasks: Array<{ id: string; title: string; state: string; acceptanceCriteria: string[] }>;
  events: Array<{ id: string; type: string; createdAt: string; payload: Record<string, unknown> }>;
  approvals: Array<{
    id: string;
    actionClass: string;
    normalizedAction: string;
    scope: string;
    status: string;
    expiresAt: string;
  }>;
  messages?: Array<{
    id: string;
    type: string;
    sender: { role: string; provider: string };
    claim: string;
    requestedAction?: string;
    confidence: number;
    timestamp: string;
  }>;
  findings?: Array<{
    id: string;
    claim: string;
    severity: string;
    affectedCriterion: string;
    requestedAction: string;
    status: string;
  }>;
  decisions?: Array<{
    id: string;
    title: string;
    rationale: string;
    status: string;
    createdAt: string;
  }>;
  blockers?: Array<{
    id: string;
    classification: string;
    summary: string;
    impact: string;
    smallestUnblockAction: string;
    status: string;
  }>;
  artifacts?: Array<{
    id: string;
    kind: string;
    label: string;
    uri: string;
    sha256?: string;
    metadata: Record<string, unknown>;
  }>;
  usage?: Array<{
    id: string;
    provider: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    elapsedMs: number;
  }>;
  attempts?: Array<{
    id: string;
    provider?: string;
    providerSessionId?: string;
    workerId?: string;
    state: string;
  }>;
};
export function RunDetail({ id }: { id: string }) {
  const [data, setData] = useState<Detail>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () =>
      fetch(`${api}/runs/${id}`)
        .then((response) => {
          if (!response.ok) throw new Error(`Run request failed with ${response.status}`);
          return response.json();
        })
        .then((value: Detail) => {
          if (active) {
            setData(value);
            setError('');
          }
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : 'Unable to load run'),
        );
    void load();
    const source = new EventSource(`${api}/runs/${id}/events`);
    source.onmessage = () => void load();
    source.onerror = () => setError('Live updates disconnected; reconnecting…');
    return () => {
      active = false;
      source.close();
    };
  }, [id, revision]);
  if (!data) return <div className="loading">{error || 'Heating the forge…'}</div>;
  const done = data.tasks.filter((t) => t.state === 'done').length;
  const evidence = data.artifacts ?? [];
  const blockers = (data.blockers ?? []).filter((blocker) => blocker.status === 'active');
  const totalTokens = (data.usage ?? []).reduce(
    (total, item) => total + item.inputTokens + item.outputTokens,
    0,
  );
  const totalCost = (data.usage ?? []).reduce((total, item) => total + item.costUsd, 0);
  const terminal = ['completed', 'partially_completed', 'cancelled', 'failed'].includes(
    data.run.state,
  );
  const canPause = !terminal && data.run.state !== 'paused';
  const canCancel = !terminal;
  return (
    <>
      <header className="topbar">
        <div>
          <a className="back" href="/">
            ← All runs
          </a>
          <p className="eyebrow">RUN {id.slice(0, 8)}</p>
          <h1>{data.run.objective}</h1>
        </div>
        <div className={`status ${data.run.state === 'completed' ? 'good' : ''}`}>
          <span />
          {data.run.state.replaceAll('_', ' ')}
        </div>
      </header>
      <div className="content">
        <section className="runSummary">
          <div>
            <small>Progress</small>
            <strong>
              {done}/{data.tasks.length} tasks
            </strong>
            <div
              className="progress"
              role="progressbar"
              aria-label="Completed tasks"
              aria-valuemin={0}
              aria-valuemax={data.tasks.length}
              aria-valuenow={done}
            >
              <i
                style={{ width: `${data.tasks.length ? (done / data.tasks.length) * 100 : 0}%` }}
              />
            </div>
          </div>
          <div>
            <small>Spend</small>
            <strong>
              ${data.run.spent.usd.toFixed(2)} / ${data.run.budget.maxUsd.toFixed(2)}
            </strong>
          </div>
          <div>
            <small>Execution policy</small>
            <strong>{data.run.configuration?.autonomyProfile ?? 'standard'} autonomy</strong>
            <small>
              {data.run.configuration?.targetBranch ?? 'main'} ·{' '}
              {data.run.configuration?.timeLimitMinutes ?? 120} min
            </small>
          </div>
          <div className="controls">
            {canPause ? <button onClick={() => control('pause')}>Pause</button> : null}
            {canCancel ? <button onClick={() => control('cancel')}>Cancel</button> : null}
            {data.run.state === 'paused' ? (
              <button onClick={() => control('resume')}>Resume</button>
            ) : null}
            {data.run.state === 'failed' || data.run.state === 'partially_completed' ? (
              <button onClick={() => control('retry')}>Retry</button>
            ) : null}
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </section>
        <div className="detailGrid">
          <section className="panel">
            <div className="sectionHead">
              <div>
                <p className="eyebrow">EXECUTION GRAPH</p>
                <h3>Tasks</h3>
              </div>
            </div>
            <div className="taskGraph">
              {data.tasks.map((task, index) => (
                <div className="task" key={task.id}>
                  <span>{index + 1}</span>
                  <div>
                    <b>{task.title}</b>
                    <small>{task.acceptanceCriteria.join(' · ')}</small>
                  </div>
                  <em className={task.state}>{task.state.replaceAll('_', ' ')}</em>
                </div>
              ))}
            </div>
          </section>
          <section className="panel" id="approvals">
            <div className="sectionHead">
              <div>
                <p className="eyebrow">EXACT-ACTION GATES</p>
                <h3>Approvals</h3>
              </div>
            </div>
            {data.approvals.length ? (
              data.approvals.map((approval) => (
                <div className="approval" key={approval.id}>
                  <div className="approvalBody">
                    <b>{approval.actionClass} action</b>
                    <small>Expires {new Date(approval.expiresAt).toLocaleString()}</small>
                    <ApprovalAction
                      normalizedAction={approval.normalizedAction}
                      scope={approval.scope}
                    />
                  </div>
                  {approval.status === 'pending' ? (
                    <div className="approvalActions">
                      <button
                        onClick={() => decide(approval.id, 'rejected')}
                        aria-label={`Reject ${approval.actionClass} action for run ${id.slice(0, 8)}`}
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => decide(approval.id, 'approved')}
                        aria-label={`Approve ${approval.actionClass} action for run ${id.slice(0, 8)}`}
                      >
                        Approve
                      </button>
                    </div>
                  ) : approval.status === 'approved' ? (
                    <div className="approvalActions">
                      <em>approved</em>
                      <button
                        onClick={() => decide(approval.id, 'approved')}
                        aria-label={`Retry integration for run ${id.slice(0, 8)}`}
                      >
                        Retry integration
                      </button>
                    </div>
                  ) : (
                    <em>{approval.status}</em>
                  )}
                </div>
              ))
            ) : (
              <p className="muted">No actions are waiting for approval.</p>
            )}
          </section>
          <section className="panel">
            <div className="sectionHead">
              <div>
                <p className="eyebrow">RESUMABLE EXECUTION</p>
                <h3>Attempts & sessions</h3>
              </div>
            </div>
            {data.attempts?.length ? (
              <div className="evidenceList">
                {data.attempts.map((attempt) => (
                  <article key={attempt.id}>
                    <b>
                      {attempt.provider ?? 'deterministic'} · {attempt.state}
                    </b>
                    <small>
                      {attempt.workerId ? `worker ${attempt.workerId}` : 'unassigned'}
                      {attempt.providerSessionId
                        ? ` · resumable session ${attempt.providerSessionId}`
                        : ''}
                    </small>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted">No execution attempt has been leased yet.</p>
            )}
          </section>
          <section className="panel">
            <div className="sectionHead">
              <div>
                <p className="eyebrow">DURABLE EVENTS</p>
                <h3>Timeline</h3>
              </div>
            </div>
            <div className="timeline">
              {data.events
                .slice()
                .reverse()
                .map((event) => (
                  <div key={event.id}>
                    <i />
                    <span>
                      <b>{event.type}</b>
                      <small>{new Date(event.createdAt).toLocaleTimeString()}</small>
                      {Object.keys(event.payload).length ? (
                        <code>{JSON.stringify(event.payload)}</code>
                      ) : null}
                    </span>
                  </div>
                ))}
            </div>
          </section>
          <section className="panel">
            <div className="sectionHead">
              <div>
                <p className="eyebrow">AGENT RECORD</p>
                <h3>Messages & decisions</h3>
              </div>
            </div>
            {(data.messages?.length ?? 0) + (data.decisions?.length ?? 0) ? (
              <div className="evidenceList">
                {data.messages?.map((message) => (
                  <article key={message.id}>
                    <b>
                      {message.sender.role} · {message.sender.provider}
                    </b>
                    <p>{message.claim}</p>
                    {message.requestedAction ? <small>{message.requestedAction}</small> : null}
                  </article>
                ))}
                {data.decisions?.map((decision) => (
                  <article key={decision.id}>
                    <b>{decision.title}</b>
                    <p>{decision.rationale}</p>
                    <small>{decision.status}</small>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted">Structured agent messages and decisions will appear here.</p>
            )}
          </section>
          <section className="panel">
            <div className="sectionHead">
              <div>
                <p className="eyebrow">INDEPENDENT REVIEW</p>
                <h3>Findings</h3>
              </div>
            </div>
            {data.findings?.length ? (
              <div className="evidenceList">
                {data.findings.map((finding) => (
                  <article key={finding.id}>
                    <b>
                      {finding.severity} · {finding.status}
                    </b>
                    <p>{finding.claim}</p>
                    <small>
                      {finding.affectedCriterion} · {finding.requestedAction}
                    </small>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted">No review findings have been recorded.</p>
            )}
          </section>
          <section className="panel">
            <div className="sectionHead">
              <div>
                <p className="eyebrow">VERIFICATION BUNDLE</p>
                <h3>Evidence & usage</h3>
              </div>
            </div>
            <p className="muted">
              {totalTokens.toLocaleString()} tokens · ${totalCost.toFixed(4)} recorded usage
            </p>
            {evidence.length ? (
              <div className="evidenceList">
                {evidence.map((artifact) => (
                  <article key={artifact.id}>
                    <b>
                      {artifact.kind} · {artifact.label}
                    </b>
                    <code>{artifact.uri}</code>
                    {artifact.sha256 ? <small>SHA-256 {artifact.sha256}</small> : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted">Evidence will appear as checks and integration steps finish.</p>
            )}
          </section>
          <section className="panel">
            <div className="sectionHead">
              <div>
                <p className="eyebrow">EXACT RESIDUAL WORK</p>
                <h3>{terminal ? 'Final report' : 'Blockers'}</h3>
                {terminal ? (
                  <a href={`${api}/runs/${id}/report`} download={`theforge-${id}-report.json`}>
                    Export evidence bundle
                  </a>
                ) : null}
              </div>
            </div>
            {blockers.length ? (
              <div className="evidenceList">
                {blockers.map((blocker) => (
                  <article key={blocker.id}>
                    <b>
                      {blocker.classification} · {blocker.summary}
                    </b>
                    <p>{blocker.impact}</p>
                    <small>{blocker.smallestUnblockAction}</small>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted">
                {terminal
                  ? `${done} of ${data.tasks.length} tasks completed; run ended ${data.run.state.replaceAll('_', ' ')}.`
                  : 'No active blocker has been recorded.'}
              </p>
            )}
          </section>
        </div>
      </div>
    </>
  );
  async function control(action: string) {
    setError('');
    try {
      const response = await fetch(`${api}/runs/${id}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(`Control failed with ${response.status}`);
      setData((current) =>
        current
          ? {
              ...current,
              run: {
                ...current.run,
                state:
                  action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'executing',
              },
            }
          : current,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Control failed');
    }
  }
  async function decide(approvalId: string, decision: 'approved' | 'rejected') {
    setError('');
    try {
      const response = await fetch(`${api}/approvals/${approvalId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) throw new Error(`Approval failed with ${response.status}`);
      setRevision((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approval failed');
    }
  }
}
