import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '@theforge/tier0';
import type { CommandContext } from './command.js';
import {
  appearedEscalation,
  backOnlineEscalation,
  createNodeWatchCommand,
  describeAge,
  runForParsing,
  looksMissing,
  parseStatus,
  pruneState,
  readState,
  selectWatch,
  shortName,
  STATE_RETENTION_MS,
  statePath,
  TAILSCALE_FALLBACKS,
  wentOfflineEscalation,
  type NodeWatchReport,
  type NodeWatchState,
  type TailscaleNode,
} from './commands/node-watch.js';
import { createRegistry } from './registry.js';

/**
 * `forge node-watch` against a fake `tailscale`: status documents in the shape
 * `tailscale status --json` really produces on this machine (27/09/2026), a
 * temporary outbox, and the file outbox as the only channel. Nothing here
 * touches the network or the tailnet.
 */
const NOW = new Date('2026-09-27T03:00:00.000Z');
const SUFFIX = 'example.ts.net.';

/** This machine: windows, online, no tags, the zero LastSeen tailscale writes. */
const SELF: TailscaleNode = {
  HostName: 'Nodee',
  DNSName: `nodee.${SUFFIX}`,
  OS: 'windows',
  Online: true,
  TailscaleIPs: ['100.64.0.12', 'fd7a:115c:a1e0::1'],
  LastSeen: '0001-01-01T00:00:00Z',
};
/** Offline since 21/06/2026: 98 days before NOW, which is the case Dan asked about. */
const NODED: TailscaleNode = {
  DNSName: `noded.${SUFFIX}`,
  OS: 'linux',
  Online: false,
  Tags: ['tag:orchestrator-node'],
  TailscaleIPs: ['100.64.0.10', 'fd7a:115c:a1e0::2'],
  sshHostKeys: ['ssh-rsa AAAA...'],
  LastSeen: '2026-06-21T02:47:16.1Z',
};
const NODEB: TailscaleNode = {
  DNSName: `nodeb.${SUFFIX}`,
  OS: 'linux',
  Online: true,
  TailscaleIPs: ['100.64.0.11'],
  sshHostKeys: ['ssh-rsa AAAA...'],
  LastSeen: '2026-09-26T05:11:04.1Z',
};
/** Meant to stay off until a later stage. */
const NODEC: TailscaleNode = {
  DNSName: `nodec.${SUFFIX}`,
  OS: 'linux',
  Online: false,
  TailscaleIPs: ['100.64.0.13'],
  sshHostKeys: ['ssh-rsa AAAA...'],
  LastSeen: '2026-09-21T12:14:01.1Z',
};
const PHONE: TailscaleNode = {
  HostName: 'localhost',
  DNSName: `nodea.${SUFFIX}`,
  OS: 'android',
  Online: false,
  TailscaleIPs: ['100.64.0.14'],
  LastSeen: '2026-09-27T02:00:00.1Z',
};

/** One `tailscale status --json` document; peers are keyed by node key, as really. */
function statusText(peers: readonly TailscaleNode[], self: TailscaleNode = SELF): string {
  return JSON.stringify({
    Version: '1.102.4-t3caf7d9e7-g084ee3b64',
    BackendState: 'Running',
    TailscaleIPs: SELF.TailscaleIPs,
    Self: self,
    Health: [],
    MagicDNSSuffix: 'example.ts.net',
    Peer: Object.fromEntries(
      peers.map((peer, index) => [`nodekey:${String(index).repeat(8)}`, peer]),
    ),
  });
}

const ok = (text: string): CommandResult => ({ exitCode: 0, output: text });
const DEFAULT = statusText([NODEB, NODEC, NODED]);
/** Node names of DEFAULT, in the order the command reports them: self, then sorted peers. */
const DEFAULT_NAMES = ['nodee', 'nodeb', 'nodec', 'noded'];

function fakeTailscale(replies: Record<string, CommandResult>) {
  const calls: { command: string; args: string[] }[] = [];
  const exec: CommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    return replies[command] ?? { exitCode: 1, output: `no fake for ${command}` };
  };
  return { exec, calls };
}

const fake = (text = DEFAULT) => fakeTailscale({ tailscale: ok(text) });

type HarnessOptions = {
  now?: Date;
  fallbacks?: readonly string[];
  exists?: (path: string) => boolean;
};

function harness(
  env: Record<string, string | undefined>,
  exec: CommandRunner,
  options: HarnessOptions = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch: () => {
      throw new Error('node-watch must not reach for the network');
    },
  };
  const command = createNodeWatchCommand({
    exec,
    now: () => options.now ?? NOW,
    // Only the bare name is tried unless a test says otherwise, so no test
    // depends on whether tailscale happens to be installed on the machine.
    fallbacks: options.fallbacks ?? [],
    exists: options.exists ?? (() => false),
  });
  return {
    out,
    err,
    run: (argv: string[]) => createRegistry([command]).run(['node-watch', ...argv], ctx),
  };
}

let directory: string;
let outbox: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'forge-node-watch-'));
  outbox = join(directory, 'outbox');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function readStateFile(): Promise<NodeWatchState> {
  return JSON.parse(await readFile(statePath(outbox), 'utf8')) as NodeWatchState;
}

type WrittenEscalation = {
  kind: string;
  severity: string;
  title: string;
  dedupeKey: string;
  what: string;
};

/** Every escalation the file outbox wrote, by kind then title. */
async function written(): Promise<WrittenEscalation[]> {
  if (!existsSync(outbox)) return [];
  const days = (await readdir(outbox)).filter((name) => /^\d{8}$/.test(name));
  const found: WrittenEscalation[] = [];
  for (const day of days) {
    for (const name of await readdir(join(outbox, day))) {
      if (!name.endsWith('.json')) continue;
      const doc = JSON.parse(await readFile(join(outbox, day, name), 'utf8')) as {
        escalation: WrittenEscalation;
      };
      found.push(doc.escalation);
    }
  }
  return found.sort((a, b) => `${a.kind}${a.title}`.localeCompare(`${b.kind}${b.title}`));
}

/** One completed run, so the next one has something to compare against. */
async function seed(text = DEFAULT): Promise<void> {
  const first = harness({ FORGE_OUTBOX_DIR: outbox }, fake(text).exec);
  expect(await first.run([])).toBe(0);
  expect(await written()).toEqual([]);
}

describe('reading tailscale status', () => {
  it('reads the short name, OS, online, tags, SSH and IP of Self and every peer', () => {
    // The fragment below is the real shape, trimmed, from this machine.
    const nodes = parseStatus(
      `{"Self":{"DNSName":"nodee.example.ts.net.","OS":"windows","Online":true},
        "Peer":{"k1":{"DNSName":"noded.example.ts.net.","OS":"linux","Online":false,
                      "Tags":["tag:orchestrator-node"],"TailscaleIPs":["100.64.0.10"],
                      "sshHostKeys":["ssh-rsa AAAA..."],"LastSeen":"2026-06-21T02:47:16.1Z"},
                "k2":{"DNSName":"nodeb.example.ts.net.","OS":"linux","Online":true,
                      "TailscaleIPs":["100.64.0.11"],"sshHostKeys":["ssh-rsa AAAA..."]}}}`,
    );
    expect(nodes).toEqual([
      {
        name: 'nodee',
        os: 'windows',
        online: true,
        ssh: false,
        tags: [],
        self: true,
      },
      {
        name: 'nodeb',
        os: 'linux',
        online: true,
        ssh: true,
        tags: [],
        ip: '100.64.0.11',
        self: false,
      },
      {
        name: 'noded',
        os: 'linux',
        online: false,
        ssh: true,
        tags: ['tag:orchestrator-node'],
        ip: '100.64.0.10',
        lastSeen: '2026-06-21T02:47:16.1Z',
        self: false,
      },
    ]);
  });

  it('falls back to the host name, ignores the zero LastSeen, and survives a missing Peer map', () => {
    expect(shortName({ DNSName: 'NODED.example.ts.net.' })).toBe('noded');
    expect(shortName({ HostName: 'Nodee' })).toBe('nodee');
    expect(shortName({})).toBe('');
    const nodes = parseStatus(JSON.stringify({ Self: SELF, Peer: null }));
    expect(nodes).toHaveLength(1);
    // 0001-01-01T00:00:00Z means "no idea", not "offline since the year one".
    expect(nodes[0]!.lastSeen).toBeUndefined();
    expect(parseStatus(JSON.stringify({ Peer: { k: { DNSName: '' } } }))).toEqual([]);
  });

  it('refuses output that is not a JSON object', () => {
    expect(() => parseStatus('not json')).toThrow(/did not return JSON/);
    expect(() => parseStatus('[]')).toThrow(/did not return an object/);
  });

  it('describes an age in the largest useful unit, and says nothing about a zero time', () => {
    expect(describeAge('2026-06-21T02:47:16.1Z', NOW.getTime())).toBe('98 days');
    expect(describeAge('2026-09-26T03:00:00.000Z', NOW.getTime())).toBe('1 day');
    expect(describeAge('2026-09-27T00:00:00.000Z', NOW.getTime())).toBe('3 h');
    expect(describeAge('2026-09-27T02:45:00.000Z', NOW.getTime())).toBe('15 m');
    expect(describeAge('0001-01-01T00:00:00Z', NOW.getTime())).toBeUndefined();
    expect(describeAge(undefined, NOW.getTime())).toBeUndefined();
    expect(describeAge('nonsense', NOW.getTime())).toBeUndefined();
  });

  it('knows a missing binary from a program that said no', () => {
    expect(looksMissing({ exitCode: -1, output: 'spawn tailscale ENOENT' })).toBe(true);
    expect(
      looksMissing({
        exitCode: 1,
        output: "'tailscale' is not recognized as an internal or external command",
      }),
    ).toBe(true);
    expect(looksMissing({ exitCode: 1, output: 'failed to connect to local tailscaled' })).toBe(
      false,
    );
    expect(TAILSCALE_FALLBACKS[0]).toBe('C:\\Program Files\\Tailscale\\tailscale.exe');
  });
});

describe('which nodes to watch', () => {
  it('prefers --node, then FORGE_WATCH_NODES, then every node', () => {
    expect(selectWatch([], undefined)).toEqual({ source: 'all', names: [] });
    expect(selectWatch([], '  ')).toEqual({ source: 'all', names: [] });
    expect(selectWatch([], 'noded, Nodec')).toEqual({ source: 'env', names: ['nodec', 'noded'] });
    expect(selectWatch(['noded', 'backupnode'], 'nodec')).toEqual({
      source: 'flag',
      names: ['backupnode', 'noded'],
    });
    expect(selectWatch(['a,b', 'b'], undefined)).toEqual({ source: 'flag', names: ['a', 'b'] });
  });
});

describe('escalations', () => {
  const noded = parseStatus(statusText([{ ...NODED, Online: true }]))[1]!;

  it('makes a return a warn, keyed on the stretch of offline it ends', () => {
    const escalation = backOnlineEscalation(
      noded,
      { online: false, checkedAt: '2026-09-27T02:30:00.000Z', lastSeen: NODED.LastSeen! },
      NOW.getTime(),
      NOW.toISOString(),
    );
    expect(escalation).toMatchObject({
      kind: 'node.back_online',
      severity: 'warn',
      paused: false,
      project: 'tailnet',
      task: 'node noded',
      title: 'Tailnet node noded is back online after 98 days offline',
      dedupeKey: `node-watch:online:noded@${NODED.LastSeen}`,
      occurredAt: NOW.toISOString(),
    });
    // What is useful on a phone: name, OS, SSH, tags, how long, the IP.
    expect(escalation.what).toContain('noded (linux) is answering on the tailnet again');
    expect(escalation.what).toContain('after 98 days offline');
    expect(escalation.what).toContain('Tailscale SSH is enabled on it');
    expect(escalation.what).toContain('tags tag:orchestrator-node');
    expect(escalation.what).toContain('100.64.0.10');
    expect(escalation.evidence).toEqual([
      'node noded',
      'os linux',
      'tailnet ip 100.64.0.10',
      'tailscale ssh enabled',
      'tags tag:orchestrator-node',
      `last seen before this ${NODED.LastSeen}`,
      'offline for 98 days',
      'previous observation 2026-09-27T02:30:00.000Z',
    ]);
  });

  it('makes a departure an info and a first sighting a warn', () => {
    const offline = wentOfflineEscalation(
      parseStatus(statusText([{ ...NODEB, Online: false }]))[1]!,
      { online: true, checkedAt: '2026-09-27T02:30:00.000Z' },
      NOW.toISOString(),
    );
    expect(offline).toMatchObject({
      kind: 'node.went_offline',
      severity: 'info',
      title: 'Tailnet node nodeb has gone offline',
      dedupeKey: `node-watch:offline:nodeb@${NODEB.LastSeen}`,
    });
    expect(offline.what).toContain('was online at the last check (2026-09-27T02:30:00.000Z)');

    const appeared = appearedEscalation(noded, NOW.getTime(), NOW.toISOString());
    expect(appeared).toMatchObject({
      kind: 'node.appeared',
      severity: 'warn',
      title: 'New node noded on the tailnet (online)',
      dedupeKey: 'node-watch:new:noded',
    });
    expect(appeared.what).toContain('node-watch has no record of it');
  });
});

describe('state file', () => {
  it('reports a missing or malformed file as "no comparison yet", and prunes long-absent nodes', async () => {
    const path = statePath(outbox);
    expect(await readState(path)).toEqual({ state: { version: 1, nodes: {} }, existed: false });

    await mkdir(join(outbox, 'node-watch'), { recursive: true });
    await writeFile(path, '{not json');
    const malformed = await readState(path);
    expect(malformed.existed).toBe(false);
    expect(malformed.warning).toMatch(/^state malformed, treating this as a first run/);

    await writeFile(
      path,
      JSON.stringify({
        nodes: {
          here: { online: true, checkedAt: '2026-09-27T00:00:00.000Z', os: 'linux', junk: 1 },
          bad: { checkedAt: '2026-09-27T00:00:00.000Z' },
          gone: {
            online: false,
            checkedAt: '2026-08-01T00:00:00.000Z',
            missingSince: '2026-08-01T00:00:00.000Z',
          },
          recently_gone: {
            online: false,
            checkedAt: '2026-09-26T00:00:00.000Z',
            missingSince: '2026-09-26T00:00:00.000Z',
          },
        },
      }),
    );
    const { state, existed } = await readState(path);
    expect(existed).toBe(true);
    expect(Object.keys(state.nodes).sort()).toEqual(['gone', 'here', 'recently_gone']);
    expect(state.nodes.here).toEqual({
      online: true,
      checkedAt: '2026-09-27T00:00:00.000Z',
      os: 'linux',
    });
    expect(Object.keys(pruneState(state, NOW.getTime()).nodes).sort()).toEqual([
      'here',
      'recently_gone',
    ]);
    expect(NOW.getTime() - Date.parse('2026-08-01T00:00:00.000Z')).toBeGreaterThan(
      STATE_RETENTION_MS,
    );
  });
});

describe('forge node-watch', () => {
  it('seeds the state file silently on the first run and escalates nothing', async () => {
    const tailscale = fake();
    const { run, out, err } = harness({ FORGE_OUTBOX_DIR: outbox }, tailscale.exec);

    expect(await run([])).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe(`outbox: ${outbox}`);
    expect(out[1]).toBe(`state: ${statePath(outbox)}`);
    expect(out[2]).toBe(
      'tailscale: tailscale; 4 node(s), watching every node (FORGE_WATCH_NODES unset)',
    );
    expect(out[3]).toBe(
      'first run: 4 node(s) recorded, nothing escalated; transitions from here on are reported',
    );
    expect(out.at(-1)).toBe('0 escalated, 0 unchanged, 4 seeded, 0 error(s)');
    expect(await written()).toEqual([]);
    expect(tailscale.calls).toEqual([{ command: 'tailscale', args: ['status', '--json'] }]);

    const state = await readStateFile();
    expect(Object.keys(state.nodes).sort()).toEqual([...DEFAULT_NAMES].sort());
    expect(state.nodes.noded).toEqual({
      online: false,
      checkedAt: NOW.toISOString(),
      os: 'linux',
      ssh: true,
      tags: ['tag:orchestrator-node'],
      ip: '100.64.0.10',
      lastSeen: NODED.LastSeen,
    });
    // The zero LastSeen is not recorded as a timestamp.
    expect(state.nodes['nodee']).toEqual({
      online: true,
      checkedAt: NOW.toISOString(),
      os: 'windows',
      ssh: false,
      ip: '100.64.0.12',
    });
  });

  it('escalates a return as a warn, is quiet on the next run, and reports a departure as an info', async () => {
    await seed();

    // noded comes back.
    const back = harness(
      { FORGE_OUTBOX_DIR: outbox },
      fake(statusText([NODEB, NODEC, { ...NODED, Online: true }])).exec,
    );
    expect(await back.run([])).toBe(0);
    expect(back.out.slice(3)).toEqual([
      'noded: BACK ONLINE after 98 days -> node.back_online -> file sent (attempt 1)',
      '1 escalated, 3 unchanged, 0 seeded, 0 error(s)',
    ]);
    expect(await written()).toEqual([
      expect.objectContaining({
        kind: 'node.back_online',
        severity: 'warn',
        title: 'Tailnet node noded is back online after 98 days offline',
      }),
    ]);
    expect((await readStateFile()).nodes.noded!.online).toBe(true);

    // Same picture half an hour later: nothing said, nothing written.
    const later = new Date(NOW.getTime() + 30 * 60_000);
    const quiet = harness(
      { FORGE_OUTBOX_DIR: outbox },
      fake(statusText([NODEB, NODEC, { ...NODED, Online: true }])).exec,
      { now: later },
    );
    expect(await quiet.run([])).toBe(0);
    expect(quiet.out.slice(3)).toEqual(['0 escalated, 4 unchanged, 0 seeded, 0 error(s)']);
    expect(await written()).toHaveLength(1);

    // nodeb drops off: info, not warn, so it never reaches the phone.
    const off = harness(
      { FORGE_OUTBOX_DIR: outbox },
      fake(
        statusText([
          { ...NODEB, Online: false, LastSeen: '2026-09-27T03:20:00.1Z' },
          NODEC,
          { ...NODED, Online: true },
        ]),
      ).exec,
      { now: later },
    );
    expect(await off.run([])).toBe(0);
    expect(off.out.slice(3)).toEqual([
      'nodeb: went offline -> node.went_offline -> file sent (attempt 1)',
      '1 escalated, 3 unchanged, 0 seeded, 0 error(s)',
    ]);
    expect((await written()).map((item) => [item.kind, item.severity])).toEqual([
      ['node.back_online', 'warn'],
      ['node.went_offline', 'info'],
    ]);
  });

  it('escalates a node it has never seen as a warn', async () => {
    await seed();
    const joined = harness(
      { FORGE_OUTBOX_DIR: outbox },
      fake(statusText([NODEB, NODEC, NODED, PHONE])).exec,
    );
    expect(await joined.run([])).toBe(0);
    expect(joined.out.slice(2)).toEqual([
      'tailscale: tailscale; 5 node(s), watching every node (FORGE_WATCH_NODES unset)',
      'nodea: NEW node (offline) -> node.appeared -> file sent (attempt 1)',
      '1 escalated, 4 unchanged, 0 seeded, 0 error(s)',
    ]);
    expect(await written()).toEqual([
      expect.objectContaining({
        kind: 'node.appeared',
        severity: 'warn',
        dedupeKey: 'node-watch:new:nodea',
      }),
    ]);
  });

  /** nodeb has dropped off and noded has come back, both since the seed run. */
  const changed = statusText([
    { ...NODEB, Online: false, LastSeen: '2026-09-27T03:20:00.1Z' },
    NODEC,
    { ...NODED, Online: true },
  ]);

  it('narrows to FORGE_WATCH_NODES but still records every node', async () => {
    await seed();
    const narrowed = harness(
      { FORGE_OUTBOX_DIR: outbox, FORGE_WATCH_NODES: 'noded, nodec' },
      fake(changed).exec,
    );
    expect(await narrowed.run([])).toBe(0);
    expect(narrowed.out[2]).toBe(
      'tailscale: tailscale; 4 node(s), watching 2 of them (FORGE_WATCH_NODES: nodec, noded)',
    );
    expect(narrowed.out.slice(3)).toEqual([
      'noded: BACK ONLINE after 98 days -> node.back_online -> file sent (attempt 1)',
      '1 escalated, 1 unchanged, 0 seeded, 0 error(s)',
    ]);
    expect((await written()).map((item) => item.kind)).toEqual(['node.back_online']);
    // nodeb went offline unwatched: recorded, so widening the watch set
    // later does not announce it as new.
    const state = await readStateFile();
    expect(state.nodes.nodeb!.online).toBe(false);
    expect(Object.keys(state.nodes).sort()).toEqual([...DEFAULT_NAMES].sort());
  });

  it('lets --node override FORGE_WATCH_NODES', async () => {
    await seed();
    const overridden = harness(
      { FORGE_OUTBOX_DIR: outbox, FORGE_WATCH_NODES: 'noded' },
      fake(changed).exec,
    );
    expect(await overridden.run(['--node=nodeb'])).toBe(0);
    expect(overridden.out[2]).toBe(
      'tailscale: tailscale; 4 node(s), watching 1 of them (--node: nodeb)',
    );
    expect(overridden.out.slice(3)).toEqual([
      'nodeb: went offline -> node.went_offline -> file sent (attempt 1)',
      '1 escalated, 0 unchanged, 0 seeded, 0 error(s)',
    ]);
  });

  it('says out loud when a watched name is not on the tailnet, and escalates nothing for it', async () => {
    await seed();
    const missing = harness(
      { FORGE_OUTBOX_DIR: outbox, FORGE_WATCH_NODES: 'backupnode' },
      fake(changed).exec,
    );
    expect(await missing.run([])).toBe(0);
    expect(missing.out[3]).toBe('watched but not on the tailnet: backupnode');
  });

  it('repeats --node to watch several nodes, and lets the notifier coalesce two returns at once', async () => {
    await seed();
    const both = harness(
      { FORGE_OUTBOX_DIR: outbox },
      fake(
        statusText([
          { ...NODEB, Online: false, LastSeen: '2026-09-27T03:20:00.1Z' },
          { ...NODEC, Online: true },
          { ...NODED, Online: true },
        ]),
      ).exec,
    );
    expect(await both.run(['--node=noded', '--node=nodec'])).toBe(0);
    expect(both.out[2]).toBe(
      'tailscale: tailscale; 4 node(s), watching 2 of them (--node: nodec, noded)',
    );
    // Two escalations of one kind inside the notifier's five-minute window: the
    // first is sent, the second is held and folded into the summary that
    // closing the notifier flushes. Both nodes are still named, once.
    expect(both.out.slice(3, 5)).toEqual([
      'nodec: BACK ONLINE after 5 days -> node.back_online -> file sent (attempt 1)',
      'noded: BACK ONLINE after 98 days -> node.back_online -> coalesced: held with 0 other(s) of kind node.back_online; a summary follows when the 5 min window closes',
    ]);
    expect((await written()).map((item) => [item.kind, item.severity, item.title])).toEqual([
      [
        'node.back_online',
        'warn',
        '1 more: Tailnet node noded is back online after 98 days offline',
      ],
      ['node.back_online', 'warn', 'Tailnet node nodec is back online after 5 days offline'],
    ]);
    // nodee and nodeb are not watched here, so they are recorded, not counted.
    expect(both.out.at(-1)).toBe('2 escalated, 0 unchanged, 0 seeded, 0 error(s)');
  });

  it('tolerates a malformed state file: a warning, a silent reseed, then comparisons again', async () => {
    await mkdir(join(outbox, 'node-watch'), { recursive: true });
    await writeFile(statePath(outbox), '{ "nodes": [oops');
    const first = harness({ FORGE_OUTBOX_DIR: outbox }, fake().exec);
    expect(await first.run([])).toBe(0);
    expect(first.err).toEqual([
      expect.stringContaining('state malformed, treating this as a first run'),
    ]);
    expect(await written()).toEqual([]);
    expect(first.out.at(-1)).toBe('0 escalated, 0 unchanged, 4 seeded, 0 error(s)');

    const second = harness(
      { FORGE_OUTBOX_DIR: outbox },
      fake(statusText([NODEB, NODEC, { ...NODED, Online: true }])).exec,
    );
    expect(await second.run([])).toBe(0);
    expect((await written()).map((item) => item.kind)).toEqual(['node.back_online']);
  });

  it('reports a tailscale that says no as an error, exits 1, and writes nothing', async () => {
    await seed();
    const before = await readStateFile();
    const broken = harness(
      { FORGE_OUTBOX_DIR: outbox },
      fakeTailscale({
        tailscale: { exitCode: 1, output: 'failed to connect to local tailscaled; is it running?' },
      }).exec,
    );
    expect(await broken.run([])).toBe(1);
    expect(broken.out).toEqual([]);
    expect(broken.err).toEqual([
      'forge node-watch: tailscale status --json failed (exit 1): failed to connect to local tailscaled; is it running?',
    ]);
    expect(await readStateFile()).toEqual(before);
    expect(await written()).toEqual([]);

    // Output that is not JSON is the same kind of failure, not a crash.
    const garbage = harness(
      { FORGE_OUTBOX_DIR: outbox },
      fakeTailscale({ tailscale: ok('<html>') }).exec,
    );
    expect(await garbage.run([])).toBe(1);
    expect(garbage.err[0]).toContain('did not return JSON');
  });

  it('falls back to the installed path when the bare name is not on PATH', async () => {
    const path = TAILSCALE_FALLBACKS[0]!;
    const tailscale = fakeTailscale({
      tailscale: {
        exitCode: 1,
        output: "'tailscale' is not recognized as an internal or external command",
      },
      [path]: ok(DEFAULT),
    });
    const { run, out } = harness({ FORGE_OUTBOX_DIR: outbox }, tailscale.exec, {
      fallbacks: [path],
      exists: (candidate) => candidate === path,
    });
    expect(await run([])).toBe(0);
    expect(out[2]).toBe(
      `tailscale: ${path}; 4 node(s), watching every node (FORGE_WATCH_NODES unset)`,
    );
    expect(tailscale.calls.map((call) => call.command)).toEqual(['tailscale', path]);

    // Nothing on PATH and no fallback that exists: one clear message, exit 1.
    const nowhere = harness(
      { FORGE_OUTBOX_DIR: outbox },
      fakeTailscale({ tailscale: { exitCode: -1, output: 'spawn tailscale ENOENT' } }).exec,
      { fallbacks: [path], exists: () => false },
    );
    expect(await nowhere.run([])).toBe(1);
    expect(nowhere.err[0]).toContain(`tailscale is not on PATH and none of ${path} exists`);
  });

  it('--dry-run says what it would send and writes neither state nor outbox', async () => {
    await seed();
    const before = await readStateFile();
    const { run, out } = harness(
      { FORGE_OUTBOX_DIR: outbox },
      fake(statusText([NODEB, NODEC, { ...NODED, Online: true }])).exec,
    );
    expect(await run(['--dry-run'])).toBe(0);
    expect(out[1]).toBe(`state: ${statePath(outbox)} (dry run: not written)`);
    expect(out).toContain('noded: BACK ONLINE after 98 days -> would send node.back_online');
    expect(out.at(-1)).toBe('dry run: 1 would be escalated, 3 unchanged, 0 seeded, 0 error(s)');
    expect(await written()).toEqual([]);
    expect(await readStateFile()).toEqual(before);
    expect(existsSync(join(outbox, 'dedupe-index.json'))).toBe(false);
  });

  it('--json prints one report document', async () => {
    await seed();
    const { run, out } = harness(
      { FORGE_OUTBOX_DIR: outbox },
      fake(statusText([NODEB, NODEC, { ...NODED, Online: true }])).exec,
    );
    expect(await run(['--json'])).toBe(0);
    expect(out).toHaveLength(1);
    const report = JSON.parse(out[0]!) as NodeWatchReport;
    expect(report).toMatchObject({
      dryRun: false,
      seeded: false,
      tailscale: 'tailscale',
      checkedAt: NOW.toISOString(),
      outboxDir: outbox,
      statePath: statePath(outbox),
      watch: { source: 'all', names: [] },
      total: 4,
      watched: 4,
      missing: [],
      summary: { escalated: 1, unchanged: 3, seeded: 0, errors: 0 },
    });
    expect(report.nodes.map((node) => [node.name, node.change, node.outcome])).toEqual([
      ['nodee', 'none', 'quiet'],
      ['nodeb', 'none', 'quiet'],
      ['nodec', 'none', 'quiet'],
      ['noded', 'back-online', 'escalated'],
    ]);
    expect(report.nodes.at(-1)!.delivery?.outcome).toBe('sent');
  });

  it('remembers a node that has left the tailnet rather than reporting it', async () => {
    await seed();
    const { run, out } = harness({ FORGE_OUTBOX_DIR: outbox }, fake(statusText([NODEB])).exec);
    expect(await run([])).toBe(0);
    expect(out.at(-1)).toBe('0 escalated, 2 unchanged, 0 seeded, 0 error(s)');
    expect(await written()).toEqual([]);
    const state = await readStateFile();
    expect(state.nodes.noded!.missingSince).toBe(NOW.toISOString());
    expect(state.nodes.nodec!.missingSince).toBe(NOW.toISOString());
    expect(state.nodes.nodeb!.missingSince).toBeUndefined();
  });

  it('rejects a bad flag with exit 2', async () => {
    const { run, err } = harness({ FORGE_OUTBOX_DIR: outbox }, fake().exec);
    expect(await run(['--node'])).toBe(2);
    expect(err.at(-1)).toContain('--node needs a short node name');
    expect(await run(['--node=not a name'])).toBe(2);
    expect(err.at(-1)).toContain("--node 'not a name' is not a short node name");
    const fromEnv = harness(
      { FORGE_OUTBOX_DIR: outbox, FORGE_WATCH_NODES: 'noded,--oops' },
      fake().exec,
    );
    expect(await fromEnv.run([])).toBe(2);
    expect(fromEnv.err.at(-1)).toContain("FORGE_WATCH_NODES '--oops' is not a short node name");
    expect(existsSync(statePath(outbox))).toBe(false);
  });
});

describe('runForParsing (BLK-025)', () => {
  // The defect this guards: node-watch used Tier 0's runCommand, which truncates
  // output at 20,000 characters because it exists to capture build logs. Once the
  // tailnet reached twelve nodes `tailscale status --json` passed that length and
  // every run died with "Bad control character in string literal in JSON at
  // position 20000" - the JSON cut mid-string. The monitor had been silently dead
  // since the tailnet grew. Mocked runners cannot catch this, because the
  // truncation lives in the real one, so these tests spawn real processes.
  const node = process.execPath;

  it('does not truncate output far beyond 20,000 characters', async () => {
    const size = 60_000;
    const result = await runForParsing(
      node,
      ['-e', `process.stdout.write('x'.repeat(${size}))`],
      process.cwd(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBe(size);
  });

  it('returns large JSON that still parses, which is the real requirement', async () => {
    // Shaped like tailscale's output: a Peer map big enough to cross the old cap.
    const script =
      'const peers = {};' +
      "for (let i = 0; i < 400; i++) peers['key' + i] = { HostName: 'node' + i, Online: false, TailscaleIPs: ['100.64.0.' + (i % 255)] };" +
      "process.stdout.write(JSON.stringify({ Self: { HostName: 'self' }, Peer: peers }));";
    const result = await runForParsing(node, ['-e', script], process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeGreaterThan(20_000);
    const parsed = JSON.parse(result.output) as { Peer: Record<string, unknown> };
    expect(Object.keys(parsed.Peer)).toHaveLength(400);
  });

  it('keeps stdout clean on success, so a warning on stderr cannot corrupt JSON', async () => {
    const result = await runForParsing(
      node,
      ['-e', "process.stderr.write('a warning'); process.stdout.write('{\"ok\":true}')"],
      process.cwd(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('{"ok":true}');
    expect(JSON.parse(result.output)).toEqual({ ok: true });
  });

  it('includes stderr on a non-zero exit, so looksMissing can still read it', async () => {
    const result = await runForParsing(
      node,
      ['-e', "process.stderr.write('ENOENT: no such file'); process.exit(3)"],
      process.cwd(),
    );
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('ENOENT');
    expect(looksMissing(result)).toBe(true);
  });

  it('reports a program that does not exist as exit -1 or a missing-command message', async () => {
    const result = await runForParsing('forge-no-such-program-xyz', ['--version'], process.cwd());
    expect(result.exitCode).not.toBe(0);
    expect(looksMissing(result)).toBe(true);
  });
});
