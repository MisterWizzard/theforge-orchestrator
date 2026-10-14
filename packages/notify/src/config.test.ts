import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  channelsFromConfig,
  createNotifierFromEnv,
  NOTIFY_DEFAULTS,
  notifyConfigFromEnv,
  resolveOutboxDir,
} from './config.js';

describe('notifyConfigFromEnv', () => {
  it('reports exactly which variables each channel still needs', () => {
    const config = notifyConfigFromEnv({});
    expect(config.ha).toEqual({ configured: false, missing: ['FORGE_HA_URL', 'FORGE_HA_TOKEN'] });
    expect(config.smtp).toEqual({
      configured: false,
      missing: ['FORGE_SMTP_USER', 'FORGE_SMTP_PASSWORD'],
    });
    expect(config.secrets).toEqual([]);
    expect(notifyConfigFromEnv({ FORGE_HA_URL: 'http://h/ha' }).ha).toEqual({
      configured: false,
      missing: ['FORGE_HA_TOKEN'],
    });
    expect(notifyConfigFromEnv({ FORGE_SMTP_USER: 'u@x.y' }).smtp).toEqual({
      configured: false,
      missing: ['FORGE_SMTP_PASSWORD'],
    });
  });

  it('applies the documented defaults once the secrets exist', () => {
    const config = notifyConfigFromEnv({
      FORGE_HA_URL: 'http://192.168.1.10/ha',
      FORGE_HA_TOKEN: 'ha-token-value',
      FORGE_SMTP_USER: 'operator@example.com',
      FORGE_SMTP_PASSWORD: 'app-password-value',
    });
    expect(config.ha).toEqual({
      configured: true,
      value: {
        url: 'http://192.168.1.10/ha',
        token: 'ha-token-value',
        service: NOTIFY_DEFAULTS.haService,
      },
    });
    expect(config.smtp).toEqual({
      configured: true,
      value: {
        host: 'smtp.gmail.com',
        port: 465,
        user: 'operator@example.com',
        password: 'app-password-value',
        to: 'operator@example.com',
      },
    });
    expect(config.secrets).toEqual(['ha-token-value', 'app-password-value']);
  });

  it('honours overrides and treats an empty value as unset, like the apps do', () => {
    const config = notifyConfigFromEnv({
      FORGE_HA_URL: 'http://h/ha',
      FORGE_HA_TOKEN: '',
      FORGE_HA_NOTIFY_SERVICE: 'mobile_app_other',
      FORGE_SMTP_HOST: 'smtp.example.com',
      FORGE_SMTP_PORT: '2525',
      FORGE_SMTP_USER: 'u@x.y',
      FORGE_SMTP_PASSWORD: 'p'.repeat(16),
      FORGE_NOTIFY_EMAIL_TO: 'other@x.y',
    });
    expect(config.ha).toEqual({ configured: false, missing: ['FORGE_HA_TOKEN'] });
    expect(config.smtp).toMatchObject({
      configured: true,
      value: { host: 'smtp.example.com', port: 2525, to: 'other@x.y' },
    });
    expect(notifyConfigFromEnv({ FORGE_SMTP_PORT: 'nope' }).smtp).toEqual({
      configured: false,
      missing: ['FORGE_SMTP_USER', 'FORGE_SMTP_PASSWORD'],
    });
  });

  it('resolves the outbox beside the workspace root unless FORGE_OUTBOX_DIR says otherwise', () => {
    expect(resolveOutboxDir({})).toBe(resolve('.forge', 'outbox'));
    expect(resolveOutboxDir({ FORGE_WORKSPACE_ROOT: 'C:/forge/state/workspaces' })).toBe(
      resolve('C:/forge/state/outbox'),
    );
    expect(
      resolveOutboxDir({ FORGE_OUTBOX_DIR: 'C:/forge/outbox', FORGE_WORKSPACE_ROOT: 'x' }),
    ).toBe(resolve('C:/forge/outbox'));
  });
});

describe('channelsFromConfig', () => {
  const full = {
    FORGE_HA_URL: 'http://h/ha',
    FORGE_HA_TOKEN: 'ha-token-value',
    FORGE_SMTP_USER: 'u@x.y',
    FORGE_SMTP_PASSWORD: 'app-password-value',
    FORGE_OUTBOX_DIR: 'C:/tmp/outbox',
  };

  it('always includes the file outbox, and the others only when configured', () => {
    expect(channelsFromConfig(notifyConfigFromEnv({})).map((c) => c.name)).toEqual(['file']);
    expect(channelsFromConfig(notifyConfigFromEnv(full)).map((c) => c.name)).toEqual([
      'file',
      'ha',
      'email',
    ]);
  });

  it('restricts to a selection without inventing an unconfigured channel', () => {
    expect(
      channelsFromConfig(notifyConfigFromEnv(full), { only: ['ha'] }).map((c) => c.name),
    ).toEqual(['ha']);
    expect(
      channelsFromConfig(notifyConfigFromEnv({}), { only: ['ha', 'email'] }).map((c) => c.name),
    ).toEqual([]);
  });

  it('builds a notifier whose channel list matches the configuration', () => {
    const { notifier, config } = createNotifierFromEnv(full);
    expect(notifier.channelNames).toEqual(['file', 'ha', 'email']);
    expect(config.outboxDir).toBe(resolve('C:/tmp/outbox'));
  });
});
