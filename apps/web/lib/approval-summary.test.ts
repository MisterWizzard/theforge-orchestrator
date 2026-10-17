import { describe, expect, it } from 'vitest';
import { summariseApproval } from './approval-summary';

const commit = '42a56a6c9fbbd218815521fe820bc759ce0faf55';
const action = JSON.stringify({
  executable: 'git',
  args: ['push', '--set-upstream', 'origin', 'forge/fec3213c'],
  cwd: '/work/managed/worktrees/fec3213c-implementation',
  workerId: null,
});
const scope = JSON.stringify({
  repositoryUrl: 'https://github.com/example/notes-app',
  baseRef: 'main',
  commit,
});

describe('summariseApproval', () => {
  it('writes the command as a person would type it', () => {
    const summary = summariseApproval(action, scope);
    expect(summary.command).toBe('git push --set-upstream origin forge/fec3213c');
  });

  it('turns the scope and working directory into labelled rows, with a short commit', () => {
    const { rows } = summariseApproval(action, scope);
    expect(rows).toEqual([
      {
        label: 'Working directory',
        value: '/work/managed/worktrees/fec3213c-implementation',
        mono: true,
      },
      { label: 'Repository', value: 'https://github.com/example/notes-app', mono: true },
      { label: 'Base branch', value: 'main', mono: true },
      { label: 'Commit', value: commit.slice(0, 12), mono: true },
    ]);
  });

  it('names the worker only when the action is pinned to one', () => {
    const pinned = JSON.stringify({
      executable: 'git',
      args: ['push'],
      cwd: '/w',
      workerId: 'linux-01',
    });
    expect(summariseApproval(pinned, scope).rows.map((row) => row.label)).toContain('Worker');
    expect(summariseApproval(action, scope).rows.map((row) => row.label)).not.toContain('Worker');
  });

  it('quotes an argument a shell would split, and leaves simple ones plain', () => {
    const quoted = JSON.stringify({
      executable: 'node',
      args: ['--test', 'my tests/a.test.js', '--name=x'],
      cwd: '/w',
    });
    expect(summariseApproval(quoted, '{}').command).toBe(
      'node --test "my tests/a.test.js" --name=x',
    );
  });

  it('says how many secrets the scan flagged', () => {
    const flagged = JSON.stringify({
      repositoryUrl: 'https://github.com/example/notes-app',
      baseRef: 'main',
      secretScan: { digest: 'abc', evidence: [{ path: 'a' }, { path: 'b' }] },
    });
    expect(summariseApproval(action, flagged).rows).toContainEqual({
      label: 'Secret scan',
      value: '2 possible secrets flagged',
      mono: false,
    });
  });

  it('keeps the exact stored action and scope, pretty-printed, for audit', () => {
    const { raw } = summariseApproval(action, scope);
    expect(JSON.parse(raw) as unknown).toEqual({
      action: JSON.parse(action) as unknown,
      scope: JSON.parse(scope) as unknown,
    });
    expect(raw).toContain('\n');
  });

  it('shows text it cannot parse as it is rather than dropping it', () => {
    const summary = summariseApproval('rm the thing', 'not json');
    expect(summary.command).toBe('rm the thing');
    expect(summary.rows).toEqual([]);
    expect(summary.raw).toBe('rm the thing\nnot json');
  });

  it('does not invent a command from JSON of an unexpected shape', () => {
    const summary = summariseApproval('{"args":["git","push"]}', '{}');
    expect(summary.command).toBeNull();
    expect(summary.raw).toContain('"args"');
  });
});
