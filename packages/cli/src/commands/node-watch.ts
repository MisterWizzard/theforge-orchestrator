/**
 * `forge node-watch`: a Tailscale node changing state, reported once.
 *
 * Dan's tailnet has nodes that are meant to be quiet. `noded` has been offline
 * since 21/06/2026 - 98 days on 27/09/2026 - and `nodec` is meant to stay off
 * until a later stage. He asked to hear about it if `noded` ever comes back
 * (ADR-031), and the same mechanism covers `nodec`, a Pi that drops off, and a
 * node he has never seen before joining the tailnet.
 *
 * The direction matters more than the change:
 *
 *   offline -> online   **warn**: the surprising direction, and the one he
 *                       asked for. warn reaches the phone (ADR-023).
 *   never seen before   **warn**: a node on the tailnet that the state file has
 *                       no record of is worth a look for the same reason.
 *   online -> offline   **info**: expected of a machine that is normally up,
 *                       so it lands in email and the outbox and not on the
 *                       phone at 2 a.m.
 *
 * `<outbox>/node-watch/state.json` remembers the last observation of every node
 * the status listed, watched or not, so repeated runs are quiet and widening
 * the watch set later does not announce nodes that were already there. The very
 * first run (no state file, or one that cannot be read) seeds that file and
 * escalates nothing, and says so.
 *
 * Tailscale is reached the way ci-watch reaches GitHub: one `tailscale status
 * --json` through the injectable `CommandRunner`, so the tests feed it JSON and
 * nothing here needs a tailnet. `tailscale` is often absent from a scheduled
 * task's PATH, so a bare name that cannot be started falls back to the
 * installed path, the way `Wait-ForgeDocker` does for docker.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createNotifierFromEnv,
  writeFileAtomically,
  type Escalation,
  type NotifierReport,
} from '@theforge/notify';
import { type CommandResult, type CommandRunner } from '@theforge/tier0';
import { parseArgs, type Command } from '../command.js';
import { formatReport } from './tier0-ingest.js';

/** Where `tailscale` lives when it is not on PATH. Windows first: this machine. */
export const TAILSCALE_FALLBACKS: readonly string[] = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  '/usr/bin/tailscale',
];
/** A marker for a node absent from the status this long is dropped. */
export const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** Tailscale writes the zero time rather than omitting `LastSeen`. */
const ZERO_TIME_PREFIX = '0001-01-01';
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// The status document
// ---------------------------------------------------------------------------

/** One node of `tailscale status --json`, in the fields this command reads. */
export type TailscaleNode = {
  DNSName?: string;
  HostName?: string;
  OS?: string;
  Online?: boolean;
  Tags?: string[];
  TailscaleIPs?: string[];
  /** Present, and non-empty, when the node advertises Tailscale SSH. */
  sshHostKeys?: string[];
  LastSeen?: string;
};

export type TailscaleStatus = {
  Self?: TailscaleNode;
  Peer?: Record<string, TailscaleNode> | null;
};

/** What this command needs to know about one node. */
export type NodeFacts = {
  /** The first label of `DNSName`, e.g. `noded`; the tailnet's own short name. */
  name: string;
  os: string;
  online: boolean;
  /** Whether it advertises Tailscale SSH. */
  ssh: boolean;
  tags: string[];
  /** The first tailnet address, which is the IPv4 one. */
  ip?: string;
  /** Absent when tailscale wrote the zero time, which means "no idea". */
  lastSeen?: string;
  /** True for the node this command runs on. */
  self: boolean;
};

/**
 * The tailnet short name: the first label of `DNSName`
 * (`noded.example.ts.net.` -> `noded`), falling back to the host name
 * lowercased when a node has no DNS name at all.
 */
export function shortName(node: TailscaleNode): string {
  const dns = (node.DNSName ?? '').trim();
  const label = dns.split('.')[0] ?? '';
  if (label) return label.toLowerCase();
  return (node.HostName ?? '').trim().toLowerCase();
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function facts(node: TailscaleNode, self: boolean): NodeFacts | undefined {
  const name = shortName(node);
  if (!name) return undefined;
  const ips = strings(node.TailscaleIPs);
  const lastSeen =
    typeof node.LastSeen === 'string' &&
    node.LastSeen &&
    !node.LastSeen.startsWith(ZERO_TIME_PREFIX)
      ? node.LastSeen
      : undefined;
  return {
    name,
    os: typeof node.OS === 'string' && node.OS ? node.OS : 'unknown',
    online: node.Online === true,
    ssh: strings(node.sshHostKeys).length > 0,
    tags: strings(node.Tags),
    ...(ips[0] !== undefined ? { ip: ips[0] } : {}),
    ...(lastSeen !== undefined ? { lastSeen } : {}),
    self,
  };
}

/**
 * Every node the status names: `Self` first, then the peers in name order, so
 * the output and the report do not move around between runs. A node without a
 * usable name is left out rather than tracked under an empty key.
 */
export function parseStatus(text: string): NodeFacts[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `tailscale status --json did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('tailscale status --json did not return an object');
  const status = parsed as TailscaleStatus;
  const found: NodeFacts[] = [];
  const seen = new Set<string>();
  const add = (node: TailscaleNode | undefined, self: boolean): void => {
    if (!node || typeof node !== 'object') return;
    const item = facts(node, self);
    if (!item || seen.has(item.name)) return;
    seen.add(item.name);
    found.push(item);
  };
  add(status.Self, true);
  const peers =
    status.Peer && typeof status.Peer === 'object' ? Object.values(status.Peer) : undefined;
  for (const peer of (peers ?? []).slice().sort((a, b) => shortName(a).localeCompare(shortName(b))))
    add(peer, false);
  return found;
}

/** "98 days", "3 h", "12 m"; undefined when the timestamp says nothing useful. */
export function describeAge(iso: string | undefined, nowMs: number): string | undefined {
  if (!iso || iso.startsWith(ZERO_TIME_PREFIX)) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const elapsed = Math.max(0, nowMs - at);
  const days = Math.floor(elapsed / 86_400_000);
  if (days >= 1) return days === 1 ? '1 day' : `${days} days`;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours >= 1) return hours === 1 ? '1 h' : `${hours} h`;
  return `${Math.floor(elapsed / 60_000)} m`;
}

// ---------------------------------------------------------------------------
// Finding and running tailscale
// ---------------------------------------------------------------------------

/**
 * Whether a failed run means "no such program" rather than "the program said
 * no". `runForParsing` reports a spawn failure as exit code -1; a shell that
 * cannot find the name says so on stderr, which is folded into the output on a
 * non-zero exit (and only then - see `runForParsing`).
 */
export function looksMissing(result: CommandResult): boolean {
  if (result.exitCode === -1) return true;
  return /not recognized as|not found|no such file|ENOENT|CommandNotFound/i.test(result.output);
}

/**
 * Reads a command's output for PARSING, which is a different job from Tier 0's
 * `runCommand` and cannot use it (BLK-025, 03/10/2026).
 *
 * Tier 0's runner exists to capture build logs for an escalation, so it does two
 * things that are right there and wrong here:
 *
 *   1. It truncates at 20,000 characters. `tailscale status --json` passed that
 *      length once the tailnet grew to twelve nodes, so every run failed with
 *      `Bad control character in string literal in JSON at position 20000` - the
 *      JSON was cut mid-string. The node watch had therefore been dead since the
 *      tailnet grew, which is the worst way for a monitor to fail: silently, and
 *      precisely when there is more to watch.
 *   2. It folds stderr into stdout. Any warning tailscale writes would corrupt
 *      the JSON. That had not bitten yet; it was waiting to.
 *
 * So: no truncation, and stdout is kept clean on success. On failure stderr is
 * appended, because `looksMissing` reads the text to tell "no such program" from
 * "the program said no", and that only matters when the exit code is non-zero.
 */
export const runForParsing: CommandRunner = async (command, args, cwd) =>
  new Promise((resolve) => {
    // No shell, on any platform. Tier 0's runner uses one on Windows (quoting each
    // argument itself) because `gh` and `git` can be .cmd shims that will not spawn
    // directly. Nothing here needs that: `tailscale` is a real .exe, and if the bare
    // name cannot be spawned the result is ENOENT, which `looksMissing` recognises,
    // so `readTailscaleStatus` falls through to the absolute path in
    // TAILSCALE_FALLBACKS - also an .exe. Passing the arguments as an array means no
    // shell ever sees them, which is both safer than quoting and simpler to be sure
    // of. A first attempt at this function did build a Windows shell string without
    // per-argument quoting, which was less safe than the code it replaced; the tests
    // in this file caught it.
    const child = spawn(command, [...args], { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ exitCode: -1, output: `${stderr}\n${String(error)}` }));
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      resolve({ exitCode, output: exitCode === 0 ? stdout : `${stdout}${stderr}` });
    });
    child.stdin?.end();
  });

export type StatusReadOptions = {
  exec: CommandRunner;
  cwd?: string;
  /** Paths to try after the bare name; only those that exist are tried. */
  fallbacks?: readonly string[];
  exists?: (path: string) => boolean;
};

/**
 * `tailscale status --json`, from PATH if it is there and from the installed
 * path if it is not. A non-zero exit that is not "no such program" - tailscale
 * stopped, not logged in - is an error and is reported as one, never retried
 * against another path.
 */
export async function readTailscaleStatus(
  options: StatusReadOptions,
): Promise<{ command: string; text: string }> {
  const exists = options.exists ?? existsSync;
  const cwd = options.cwd ?? process.cwd();
  const candidates = [
    'tailscale',
    ...(options.fallbacks ?? TAILSCALE_FALLBACKS).filter((path) => exists(path)),
  ];
  let lastMissing = '';
  for (const command of candidates) {
    const result = await options.exec(command, ['status', '--json'], cwd);
    if (result.exitCode === 0) return { command, text: result.output };
    if (!looksMissing(result))
      throw new Error(
        `${command} status --json failed (exit ${result.exitCode}): ${clip(result.output)}`,
      );
    lastMissing = `${command}: ${clip(result.output, 120)}`;
  }
  throw new Error(
    `tailscale is not on PATH and none of ${(options.fallbacks ?? TAILSCALE_FALLBACKS).join(', ')} exists (${lastMissing})`,
  );
}

const clip = (text: string, max = 300): string =>
  text.trim().length > max ? `${text.trim().slice(0, max)}…` : text.trim();

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

export type NodeMarker = {
  online: boolean;
  /** When this observation was made. */
  checkedAt: string;
  os?: string;
  ssh?: boolean;
  tags?: string[];
  ip?: string;
  /** `LastSeen` as tailscale reported it at that observation. */
  lastSeen?: string;
  /** Set while the node is absent from the status; the prune reads it. */
  missingSince?: string;
};

export type NodeWatchState = {
  version: 1;
  /** Short name -> last observation. Every node seen, watched or not. */
  nodes: Record<string, NodeMarker>;
};

export function statePath(outboxDir: string): string {
  return join(outboxDir, 'node-watch', 'state.json');
}

const emptyState = (): NodeWatchState => ({ version: 1, nodes: {} });

function nodes(value: unknown): Record<string, NodeMarker> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, NodeMarker> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const marker = raw as Record<string, unknown>;
    if (typeof marker.online !== 'boolean' || typeof marker.checkedAt !== 'string') continue;
    result[name] = {
      online: marker.online,
      checkedAt: marker.checkedAt,
      ...(typeof marker.os === 'string' ? { os: marker.os } : {}),
      ...(typeof marker.ssh === 'boolean' ? { ssh: marker.ssh } : {}),
      ...(Array.isArray(marker.tags) ? { tags: strings(marker.tags) } : {}),
      ...(typeof marker.ip === 'string' ? { ip: marker.ip } : {}),
      ...(typeof marker.lastSeen === 'string' ? { lastSeen: marker.lastSeen } : {}),
      ...(typeof marker.missingSince === 'string' ? { missingSince: marker.missingSince } : {}),
    };
  }
  return result;
}

/**
 * The state file. `existed` is false when there is nothing usable to compare
 * against - no file, or a file that cannot be read or parsed - and the caller
 * seeds silently on that reading rather than calling every node new.
 */
export async function readState(
  path: string,
): Promise<{ state: NodeWatchState; warning?: string; existed: boolean }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { state: emptyState(), existed: false };
    return {
      state: emptyState(),
      existed: false,
      warning: `state unreadable, treating this as a first run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not an object');
    return {
      state: { version: 1, nodes: nodes((parsed as Record<string, unknown>).nodes) },
      existed: true,
    };
  } catch (error) {
    return {
      state: emptyState(),
      existed: false,
      warning: `state malformed, treating this as a first run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function writeState(path: string, state: NodeWatchState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomically(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Drop nodes that have been absent from the status for longer than the retention. */
export function pruneState(state: NodeWatchState, nowMs: number): NodeWatchState {
  return {
    version: 1,
    nodes: Object.fromEntries(
      Object.entries(state.nodes).filter(([, marker]) => {
        if (!marker.missingSince) return true;
        const at = Date.parse(marker.missingSince);
        return Number.isNaN(at) || nowMs - at < STATE_RETENTION_MS;
      }),
    ),
  };
}

export function markerFor(node: NodeFacts, checkedAt: string): NodeMarker {
  return {
    online: node.online,
    checkedAt,
    os: node.os,
    ssh: node.ssh,
    ...(node.tags.length ? { tags: node.tags } : {}),
    ...(node.ip !== undefined ? { ip: node.ip } : {}),
    ...(node.lastSeen !== undefined ? { lastSeen: node.lastSeen } : {}),
  };
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

export const backOnlineDedupeKey = (name: string, since: string): string =>
  `node-watch:online:${name}@${since}`;
export const wentOfflineDedupeKey = (name: string, since: string): string =>
  `node-watch:offline:${name}@${since}`;
export const appearedDedupeKey = (name: string): string => `node-watch:new:${name}`;

const sshText = (node: NodeFacts): string =>
  node.ssh ? 'Tailscale SSH is enabled on it' : 'it does not advertise Tailscale SSH';
const tagText = (node: NodeFacts): string =>
  node.tags.length ? `tags ${node.tags.join(', ')}` : 'no tags';
const capitalise = (text: string): string => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

/** The lines every one of these messages carries, in a fixed order. */
function nodeEvidence(node: NodeFacts): string[] {
  return [
    `node ${node.name}${node.self ? ' (this machine)' : ''}`,
    `os ${node.os}`,
    ...(node.ip ? [`tailnet ip ${node.ip}`] : []),
    `tailscale ssh ${node.ssh ? 'enabled' : 'not advertised'}`,
    `tags ${node.tags.length ? node.tags.join(', ') : 'none'}`,
  ];
}

/**
 * Offline to online: the direction Dan asked about, so **warn**, which reaches
 * the phone. The key is the node plus the start of the offline stretch, so the
 * same return is one message however many times the state file is rebuilt.
 */
export function backOnlineEscalation(
  node: NodeFacts,
  previous: NodeMarker,
  nowMs: number,
  occurredAt: string,
): Escalation {
  const since = previous.lastSeen ?? previous.checkedAt;
  const age = describeAge(since, nowMs);
  const forHowLong = age ? ` after ${age} offline` : '';
  return {
    kind: 'node.back_online',
    severity: 'warn',
    title: `Tailnet node ${node.name} is back online${forHowLong}`,
    what: `${node.name} (${node.os}) is answering on the tailnet again${forHowLong}; it was last seen ${since}${node.ip ? ` and is on ${node.ip}` : ''}. ${capitalise(sshText(node))}, and it has ${tagText(node)}. A node coming back is the surprising direction: either you brought it up, or something else did.`,
    project: 'tailnet',
    task: `node ${node.name}`,
    options: [
      {
        label: 'Leave it, if you brought it up yourself',
        consequence:
          'Nothing changes; the node stays on the tailnet and this return is not mentioned again.',
      },
      {
        label: `Look at what it is doing: tailscale status, then ssh ${node.name} if Tailscale SSH is on`,
        consequence: 'Read-only; tells you who is on it and what it is running.',
      },
      {
        label: 'Disable or remove the node in the Tailscale admin console',
        consequence:
          'It loses tailnet access at once and has to be re-authorised to come back, so do it only if the return is unexplained.',
      },
    ],
    recommendation: node.self
      ? 'This is the machine the watch runs on, so it is almost certainly your own doing; no action unless you did not restart it.'
      : 'Account for it first. If you did not bring it up and cannot explain who did, disable it in the admin console before investigating further.',
    evidence: [
      ...nodeEvidence(node),
      `last seen before this ${since}`,
      ...(age ? [`offline for ${age}`] : []),
      `previous observation ${previous.checkedAt}`,
    ],
    paused: false,
    dedupeKey: backOnlineDedupeKey(node.name, since),
    occurredAt,
  };
}

/**
 * Online to offline: expected of a machine that is normally up, so **info** -
 * email and the file outbox, not the phone (ADR-023). It is the reading that
 * notices a Pi has dropped off, without waking anyone for a reboot.
 */
export function wentOfflineEscalation(
  node: NodeFacts,
  previous: NodeMarker,
  occurredAt: string,
): Escalation {
  const since = node.lastSeen ?? previous.checkedAt;
  return {
    kind: 'node.went_offline',
    severity: 'info',
    title: `Tailnet node ${node.name} has gone offline`,
    what: `${node.name} (${node.os}) was online at the last check (${previous.checkedAt}) and is offline now; tailscale last saw it ${since}${node.ip ? `, on ${node.ip}` : ''}. It has ${tagText(node)}. A machine that is normally up dropping off is worth knowing but not worth a phone call, so this is an info.`,
    project: 'tailnet',
    task: `node ${node.name}`,
    options: [
      {
        label: 'Nothing, if the machine is meant to be off',
        consequence: 'The state file records it as offline and its return will be a warn.',
      },
      {
        label: 'Power it back on, or check its network',
        consequence: 'It rejoins the tailnet and its return is reported as a warn.',
      },
    ],
    recommendation:
      'No action if you turned it off. If it is meant to be up, this is the first sign it is not.',
    evidence: [...nodeEvidence(node), `last seen ${since}`, `online at ${previous.checkedAt}`],
    paused: false,
    dedupeKey: wentOfflineDedupeKey(node.name, since),
    occurredAt,
  };
}

/**
 * A node the state file has never held: **warn**, for the same reason as a
 * return. On the first run every node is like this, which is why that run seeds
 * the file instead of escalating.
 */
export function appearedEscalation(node: NodeFacts, nowMs: number, occurredAt: string): Escalation {
  const age = describeAge(node.lastSeen, nowMs);
  return {
    kind: 'node.appeared',
    severity: 'warn',
    title: `New node ${node.name} on the tailnet (${node.online ? 'online' : 'offline'})`,
    what: `${node.name} (${node.os}) is on the tailnet and node-watch has no record of it${node.ip ? `; it is on ${node.ip}` : ''}. It is ${node.online ? 'online now' : `offline${age ? `, last seen ${age} ago` : ''}`}, ${sshText(node)}, and it has ${tagText(node)}. Either you added it, or something joined the tailnet that should not have.`,
    project: 'tailnet',
    task: `node ${node.name}`,
    options: [
      {
        label: 'Leave it, if you added it yourself',
        consequence: 'It is recorded, and from now on only its transitions are reported.',
      },
      {
        label: 'Check it in the Tailscale admin console: who authorised it, and when',
        consequence: 'Read-only; the machine list shows the user and the key that added it.',
      },
      {
        label: 'Remove it from the tailnet',
        consequence: 'It loses access at once and has to be re-authorised.',
      },
    ],
    recommendation:
      'If you did not add it, remove it in the admin console before anything else; a node on the tailnet can reach whatever the ACLs allow.',
    evidence: [
      ...nodeEvidence(node),
      `online ${node.online}`,
      ...(node.lastSeen ? [`last seen ${node.lastSeen}`] : []),
    ],
    paused: false,
    dedupeKey: appearedDedupeKey(node.name),
    occurredAt,
  };
}

// ---------------------------------------------------------------------------
// Which nodes to watch
// ---------------------------------------------------------------------------

export type WatchSelection = {
  /** Where the set came from. `all` means every node the status lists. */
  source: 'flag' | 'env' | 'all';
  /** Lowercase short names; empty for `all`. */
  names: string[];
};

/**
 * `--node=` (repeatable, and comma separated) wins over `FORGE_WATCH_NODES`,
 * which is also comma separated. Neither given means every node: a node
 * appearing that Dan does not know about is exactly what he wants to hear
 * about, so the default is to watch the lot rather than nothing.
 */
export function selectWatch(nodeFlags: readonly string[], env: string | undefined): WatchSelection {
  const split = (values: readonly string[]): string[] => [
    ...new Set(
      values
        .flatMap((value) => value.split(','))
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const fromFlags = split(nodeFlags);
  if (fromFlags.length) return { source: 'flag', names: fromFlags.sort() };
  const fromEnv = split(env === undefined ? [] : [env]);
  if (fromEnv.length) return { source: 'env', names: fromEnv.sort() };
  return { source: 'all', names: [] };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export type NodeWatchCommandOptions = {
  /** Process runner for `tailscale`; defaults to spawning it. */
  exec?: CommandRunner;
  now?: () => Date;
  /** Paths tried after the bare name; tests pass their own. */
  fallbacks?: readonly string[];
  exists?: (path: string) => boolean;
};

export type NodeChange = 'back-online' | 'went-offline' | 'appeared' | 'none' | 'seeded';
export type NodeOutcome = 'escalated' | 'would-escalate' | 'quiet' | 'seeded' | 'unwatched';

export type NodeResult = {
  name: string;
  online: boolean;
  os: string;
  change: NodeChange;
  outcome: NodeOutcome;
  detail: string;
  delivery?: NotifierReport;
};

export type NodeWatchReport = {
  dryRun: boolean;
  /** True when this run only seeded the state file. */
  seeded: boolean;
  /** The tailscale binary that answered. */
  tailscale: string;
  checkedAt: string;
  outboxDir: string;
  statePath: string;
  watch: WatchSelection;
  /** Nodes the status listed. */
  total: number;
  /** Of those, how many are watched. */
  watched: number;
  /** Watched names the status does not list. */
  missing: string[];
  nodes: NodeResult[];
  summary: { escalated: number; unchanged: number; seeded: number; errors: number };
};

export function createNodeWatchCommand(options: NodeWatchCommandOptions = {}): Command {
  const exec = options.exec ?? runForParsing;
  const clock = options.now ?? (() => new Date());
  return {
    name: 'node-watch',
    describe:
      'Escalate a watched Tailscale node coming back online (warn), going offline (info) or appearing for the first time (warn)',
    usage: '[--node=name]... [--dry-run] [--json]',
    async run(argv, ctx) {
      const { flags } = parseArgs(argv);
      const fail = (message: string): number => {
        ctx.stderr(`forge node-watch: ${message}`);
        return 2;
      };
      // parseArgs keeps one value per flag; --node is repeatable, so the raw
      // argument list is what decides the set.
      const nodeFlags = argv
        .filter((argument) => argument.startsWith('--node='))
        .map((argument) => argument.slice('--node='.length));
      if (flags.get('node') === true)
        return fail('--node needs a short node name, e.g. --node=noded (repeat it for more)');
      const watch = selectWatch(nodeFlags, ctx.env.FORGE_WATCH_NODES);
      for (const name of watch.names)
        if (!NODE_NAME.test(name))
          return fail(
            `${watch.source === 'flag' ? '--node' : 'FORGE_WATCH_NODES'} '${name}' is not a short node name`,
          );
      const dryRun = flags.has('dry-run');
      const json = flags.has('json');

      const now = clock();
      const nowMs = now.getTime();
      const checkedAt = now.toISOString();
      const { notifier, config } = createNotifierFromEnv(ctx.env, {
        fetch: ctx.fetch,
        log: (line) => ctx.stderr(line),
        now: () => nowMs,
      });
      const path = statePath(config.outboxDir);

      let observed: NodeFacts[];
      let tailscale: string;
      try {
        const status = await readTailscaleStatus({
          exec,
          ...(options.fallbacks !== undefined ? { fallbacks: options.fallbacks } : {}),
          ...(options.exists !== undefined ? { exists: options.exists } : {}),
        });
        tailscale = status.command;
        observed = parseStatus(status.text);
      } catch (error) {
        await notifier.close();
        ctx.stderr(`forge node-watch: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }

      const { state: loaded, warning, existed } = await readState(path);
      if (warning) ctx.stderr(`forge node-watch: ${warning}`);
      const state = pruneState(loaded, nowMs);
      const seeding = !existed;

      const isWatched = (name: string): boolean =>
        watch.source === 'all' || watch.names.includes(name);
      const present = new Set(observed.map((node) => node.name));
      const report: NodeWatchReport = {
        dryRun,
        seeded: seeding,
        tailscale,
        checkedAt,
        outboxDir: config.outboxDir,
        statePath: path,
        watch,
        total: observed.length,
        watched: observed.filter((node) => isWatched(node.name)).length,
        missing: watch.names.filter((name) => !present.has(name)),
        nodes: [],
        summary: { escalated: 0, unchanged: 0, seeded: 0, errors: 0 },
      };
      const lines: string[] = [];
      const say = (line: string) => lines.push(line);
      let channelFailed = false;

      const deliver = async (
        escalation: Escalation,
      ): Promise<{ outcome: NodeOutcome; detail: string; delivery?: NotifierReport }> => {
        if (dryRun) {
          report.summary.escalated += 1;
          return { outcome: 'would-escalate', detail: `would send ${escalation.kind}` };
        }
        const delivery = await notifier.notify(escalation);
        if (delivery.outcome === 'failed' || delivery.channels.some((c) => c.status === 'failed'))
          channelFailed = true;
        report.summary.escalated += 1;
        return {
          outcome: 'escalated',
          detail: `${escalation.kind} -> ${formatReport(delivery)}`,
          delivery,
        };
      };

      try {
        for (const node of observed) {
          const base = { name: node.name, online: node.online, os: node.os };
          const previous = state.nodes[node.name];
          state.nodes[node.name] = markerFor(node, checkedAt);
          if (seeding) {
            report.nodes.push({
              ...base,
              change: 'seeded',
              outcome: 'seeded',
              detail: `recorded as ${node.online ? 'online' : 'offline'}`,
            });
            report.summary.seeded += 1;
            continue;
          }
          if (!isWatched(node.name)) {
            report.nodes.push({
              ...base,
              change: 'none',
              outcome: 'unwatched',
              detail: 'not watched; recorded only',
            });
            continue;
          }
          let escalation: Escalation | undefined;
          let change: NodeChange = 'none';
          if (!previous) {
            change = 'appeared';
            escalation = appearedEscalation(node, nowMs, checkedAt);
          } else if (!previous.online && node.online) {
            change = 'back-online';
            escalation = backOnlineEscalation(node, previous, nowMs, checkedAt);
          } else if (previous.online && !node.online) {
            change = 'went-offline';
            escalation = wentOfflineEscalation(node, previous, checkedAt);
          }
          if (!escalation) {
            report.nodes.push({
              ...base,
              change: 'none',
              outcome: 'quiet',
              detail: `still ${node.online ? 'online' : 'offline'}`,
            });
            report.summary.unchanged += 1;
            continue;
          }
          const sent = await deliver(escalation);
          report.nodes.push({ ...base, change, ...sent });
          say(`${node.name}: ${changeText(change, node, previous, nowMs)} -> ${sent.detail}`);
        }
        // A node the status no longer lists is remembered, not reported: a
        // removal is a deliberate act and the marker is pruned after 30 days.
        for (const [name, marker] of Object.entries(state.nodes)) {
          if (present.has(name)) continue;
          if (!marker.missingSince) state.nodes[name] = { ...marker, missingSince: checkedAt };
        }
      } finally {
        await notifier.close();
      }

      if (!dryRun) {
        try {
          await writeState(path, state);
        } catch (error) {
          ctx.stderr(
            `forge node-watch: state not saved: ${error instanceof Error ? error.message : String(error)}`,
          );
          report.summary.errors += 1;
        }
      }

      if (json) {
        ctx.stdout(JSON.stringify(report));
      } else {
        ctx.stdout(`outbox: ${config.outboxDir}`);
        ctx.stdout(`state: ${path}${dryRun ? ' (dry run: not written)' : ''}`);
        ctx.stdout(
          `tailscale: ${tailscale}; ${observed.length} node(s), watching ${
            watch.source === 'all'
              ? 'every node (FORGE_WATCH_NODES unset)'
              : `${report.watched} of them (${watch.source === 'flag' ? '--node' : 'FORGE_WATCH_NODES'}: ${watch.names.join(', ')})`
          }`,
        );
        for (const name of report.missing) ctx.stdout(`watched but not on the tailnet: ${name}`);
        if (seeding)
          ctx.stdout(
            `first run: ${report.summary.seeded} node(s) recorded, nothing escalated; transitions from here on are reported`,
          );
        for (const line of lines) ctx.stdout(line);
        const s = report.summary;
        ctx.stdout(
          `${dryRun ? 'dry run: ' : ''}${s.escalated} ${dryRun ? 'would be escalated' : 'escalated'}, ${s.unchanged} unchanged, ${s.seeded} seeded, ${s.errors} error(s)`,
        );
      }
      return report.summary.errors || channelFailed ? 1 : 0;
    },
  };
}

function changeText(
  change: NodeChange,
  node: NodeFacts,
  previous: NodeMarker | undefined,
  nowMs: number,
): string {
  if (change === 'back-online') {
    const age = describeAge(previous?.lastSeen ?? previous?.checkedAt, nowMs);
    return `BACK ONLINE${age ? ` after ${age}` : ''}`;
  }
  if (change === 'went-offline') return 'went offline';
  if (change === 'appeared') return `NEW node (${node.online ? 'online' : 'offline'})`;
  return 'no change';
}

export const nodeWatchCommand: Command = createNodeWatchCommand();
