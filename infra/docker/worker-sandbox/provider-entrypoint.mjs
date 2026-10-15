#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';

const MAX_INPUT_BYTES = 16_000_000;
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > MAX_INPUT_BYTES) throw new Error('Provider container input exceeded 16 MB');
  chunks.push(chunk);
}
const input = Buffer.concat(chunks);
const delimiter = input.indexOf(0x0a);
if (delimiter < 0) throw new Error('Provider container credential envelope is missing');
const envelope = JSON.parse(input.subarray(0, delimiter).toString('utf8'));
const provider = process.argv[2];
if (provider !== 'claude' && provider !== 'codex') throw new Error('Unsupported provider');
if (!envelope || !['api-key', 'auth-file'].includes(envelope.kind))
  throw new Error('Invalid provider credential envelope');
const secret = Buffer.from(String(envelope.contentBase64 ?? ''), 'base64');
if (secret.length === 0 || secret.length > 1_000_000)
  throw new Error('Invalid provider credential size');

const childEnvironment = { ...process.env };
if (envelope.kind === 'api-key') {
  childEnvironment[provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'] =
    secret.toString('utf8');
} else {
  if (provider !== 'codex') throw new Error('Only the Codex CLI takes an auth file');
  const directory = '/home/node/.codex';
  const path = `${directory}/auth.json`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, secret, { mode: 0o600 });
}

const command = provider === 'claude' ? '/usr/local/bin/claude' : '/usr/local/bin/codex';
const providerArgs = process.argv.slice(3);
if (provider === 'claude' && envelope.claudePromptBase64 !== undefined) {
  const prompt = Buffer.from(String(envelope.claudePromptBase64), 'base64');
  providerArgs.unshift('-p', prompt.toString('utf8'));
}
if (provider === 'codex' && envelope.codexSchemaBase64 !== undefined) {
  const schema = Buffer.from(String(envelope.codexSchemaBase64), 'base64');
  if (schema.length === 0 || schema.length > 1_000_000)
    throw new Error('Invalid Codex output schema size');
  await writeFile('/tmp/theforge-output-schema.json', schema, { mode: 0o600 });
}
const child = spawn(command, providerArgs, {
  cwd: '/workspace',
  env: childEnvironment,
  shell: false,
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.end(input.subarray(delimiter + 1));
const forward = (signal) => child.kill(signal);
process.once('SIGTERM', () => forward('SIGTERM'));
process.once('SIGINT', () => forward('SIGINT'));
child.once('error', (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 127;
});
child.once('close', (code, signal) => {
  process.exitCode = code ?? (signal ? 128 : 1);
});
