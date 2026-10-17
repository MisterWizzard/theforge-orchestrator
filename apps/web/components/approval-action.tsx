import { summariseApproval } from '../lib/approval-summary';

/**
 * What an approval would do, laid out to be read: the command in a block that
 * scrolls inside its card, the key fields as labelled rows, and the exact stored
 * action behind a disclosure so nothing is hidden from the person deciding.
 */
export function ApprovalAction({
  normalizedAction,
  scope,
}: {
  normalizedAction: string;
  scope: string;
}) {
  const summary = summariseApproval(normalizedAction, scope);
  return (
    <div className="approvalDetail">
      {summary.command ? (
        <pre className="approvalCommand" tabIndex={0} aria-label="Command awaiting approval">
          <code>{summary.command}</code>
        </pre>
      ) : null}
      {summary.rows.length ? (
        <dl className="approvalFacts">
          {summary.rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd className={row.mono ? 'mono' : undefined}>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <details className="approvalRaw">
        <summary>Exact stored action</summary>
        <pre tabIndex={0} aria-label="Exact stored action and scope">
          <code>{summary.raw}</code>
        </pre>
      </details>
    </div>
  );
}
