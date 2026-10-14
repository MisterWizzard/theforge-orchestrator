/**
 * Configuration from the environment, and the notifier assembled from it.
 *
 * The two secrets - the Home Assistant long-lived token and the Gmail app
 * password - are Dan-only manual actions. Until they exist the notifier has
 * to work anyway: the file outbox is always on, and each missing channel is
 * reported by the exact variables it needs rather than silently skipped.
 */
import { resolve } from 'node:path';
import type { Channel } from './channel.js';
import { HaPushChannel } from './ha.js';
import { Notifier, type NotifierOptions } from './notifier.js';
import { FileOutboxChannel } from './outbox.js';
import { SmtpChannel } from './smtp.js';

export type EnvironmentLike = Readonly<Record<string, string | undefined>>;

export const NOTIFY_DEFAULTS = {
  haService: 'mobile_app_phone',
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  emailTo: 'operator@example.com',
  /** Mirrors the coordinator's FORGE_WORKSPACE_ROOT default. */
  workspaceRoot: '.forge/workspaces',
} as const;

export type HaConfig = { url: string; token: string; service: string };
export type SmtpConfig = { host: string; port: number; user: string; password: string; to: string };

export type NotifyConfig = {
  outboxDir: string;
  /** Configured, or the variables still needed. */
  ha: { configured: true; value: HaConfig } | { configured: false; missing: string[] };
  smtp: { configured: true; value: SmtpConfig } | { configured: false; missing: string[] };
  /** Every secret value in play, for redaction. */
  secrets: string[];
};

/** `KEY=` under Node's --env-file is the empty string; treat it as unset, as the apps do. */
function read(env: EnvironmentLike, variable: string): string | undefined {
  const value = env[variable];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * FORGE_OUTBOX_DIR when set; otherwise beside the workspace root, the same
 * place the halt file lives, so everything TheForge writes for a human is in
 * one directory above the worktrees it creates and deletes.
 */
export function resolveOutboxDir(env: EnvironmentLike): string {
  const explicit = read(env, 'FORGE_OUTBOX_DIR');
  if (explicit) return resolve(explicit);
  return resolve(
    read(env, 'FORGE_WORKSPACE_ROOT') ?? NOTIFY_DEFAULTS.workspaceRoot,
    '..',
    'outbox',
  );
}

export function notifyConfigFromEnv(env: EnvironmentLike): NotifyConfig {
  const haUrl = read(env, 'FORGE_HA_URL');
  const haToken = read(env, 'FORGE_HA_TOKEN');
  const haMissing = [...(haUrl ? [] : ['FORGE_HA_URL']), ...(haToken ? [] : ['FORGE_HA_TOKEN'])];
  const smtpUser = read(env, 'FORGE_SMTP_USER');
  const smtpPassword = read(env, 'FORGE_SMTP_PASSWORD');
  const smtpMissing = [
    ...(smtpUser ? [] : ['FORGE_SMTP_USER']),
    ...(smtpPassword ? [] : ['FORGE_SMTP_PASSWORD']),
  ];
  const port = Number(read(env, 'FORGE_SMTP_PORT') ?? NOTIFY_DEFAULTS.smtpPort);
  return {
    outboxDir: resolveOutboxDir(env),
    ha:
      haUrl && haToken
        ? {
            configured: true,
            value: {
              url: haUrl,
              token: haToken,
              service: read(env, 'FORGE_HA_NOTIFY_SERVICE') ?? NOTIFY_DEFAULTS.haService,
            },
          }
        : { configured: false, missing: haMissing },
    smtp:
      smtpUser && smtpPassword
        ? {
            configured: true,
            value: {
              host: read(env, 'FORGE_SMTP_HOST') ?? NOTIFY_DEFAULTS.smtpHost,
              port: Number.isInteger(port) && port > 0 ? port : NOTIFY_DEFAULTS.smtpPort,
              user: smtpUser,
              password: smtpPassword,
              to: read(env, 'FORGE_NOTIFY_EMAIL_TO') ?? NOTIFY_DEFAULTS.emailTo,
            },
          }
        : { configured: false, missing: smtpMissing },
    secrets: [haToken, smtpPassword].filter((value): value is string => Boolean(value)),
  };
}

export type ChannelSelection = 'ha' | 'email' | 'file';

export type CreateNotifierOptions = Omit<NotifierOptions, 'channels' | 'outboxDir' | 'secrets'> & {
  fetch?: typeof globalThis.fetch;
  /** Restrict to these channels; the default is every configured one. */
  only?: readonly ChannelSelection[];
};

/** The channels the configuration allows, file outbox first. */
export function channelsFromConfig(
  config: NotifyConfig,
  options: Pick<CreateNotifierOptions, 'fetch' | 'only' | 'now' | 'timeZone'> = {},
): Channel[] {
  const wanted = (name: ChannelSelection) => !options.only || options.only.includes(name);
  const channels: Channel[] = [];
  if (wanted('file')) {
    channels.push(
      new FileOutboxChannel({
        dir: config.outboxDir,
        ...(options.timeZone !== undefined ? { timeZone: options.timeZone } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      }),
    );
  }
  if (wanted('ha') && config.ha.configured) {
    channels.push(
      new HaPushChannel({
        baseUrl: config.ha.value.url,
        token: config.ha.value.token,
        service: config.ha.value.service,
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      }),
    );
  }
  if (wanted('email') && config.smtp.configured) {
    channels.push(
      new SmtpChannel({
        ...config.smtp.value,
        fromName: 'TheForge',
        ...(options.now !== undefined ? { now: options.now } : {}),
      }),
    );
  }
  return channels;
}

export function createNotifier(
  config: NotifyConfig,
  options: CreateNotifierOptions = {},
): Notifier {
  // `fetch` and `only` ride along in the spread; the Notifier ignores them.
  return new Notifier({
    ...options,
    channels: channelsFromConfig(config, options),
    outboxDir: config.outboxDir,
    secrets: config.secrets,
  });
}

export function createNotifierFromEnv(
  env: EnvironmentLike,
  options: CreateNotifierOptions = {},
): { notifier: Notifier; config: NotifyConfig } {
  const config = notifyConfigFromEnv(env);
  return { notifier: createNotifier(config, options), config };
}
