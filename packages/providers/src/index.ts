import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { ProviderEventSchema, type ProviderEvent, type ProviderRequest } from '@theforge/contracts';

export type ProviderCapabilities = {
  streaming: boolean;
  resume: boolean;
  tools: boolean;
  structuredOutput: boolean;
  usage: boolean;
  /**
   * Runs on the worker host against a local model server: no sandbox, no
   * credential, no marginal cost, so the spend ceiling never applies to it.
   * Absent means a cloud provider.
   */
  local?: boolean;
};
export type ProviderDiagnostic = {
  available: boolean;
  authenticated: boolean;
  version?: string;
  detail: string;
};
export interface ProviderAdapter {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  diagnose(): Promise<ProviderDiagnostic>;
  run(
    request: ProviderRequest,
    options: { cwd: string; signal?: AbortSignal },
  ): AsyncIterable<ProviderEvent>;
}

export class FakeProvider implements ProviderAdapter {
  readonly id = 'fake';
  readonly capabilities = {
    streaming: true,
    resume: true,
    tools: true,
    structuredOutput: true,
    usage: true,
  };
  constructor(
    private readonly script: ProviderEvent[] = [
      { type: 'text_delta', text: 'done' },
      { type: 'usage', inputTokens: 1, outputTokens: 1, usd: 0 },
      { type: 'completed', sessionId: 'fake-session', output: { ok: true } },
    ],
  ) {}
  async diagnose() {
    return {
      available: true,
      authenticated: true,
      version: 'deterministic',
      detail: 'Fake provider ready',
    };
  }
  async *run(
    request: ProviderRequest,
    options: { cwd: string; signal?: AbortSignal },
  ): AsyncGenerator<ProviderEvent> {
    void request;
    void options.cwd;
    for (const event of this.script) {
      if (options.signal?.aborted) {
        yield {
          type: 'error',
          code: 'CANCELLED',
          message: 'Provider call cancelled',
          retryable: false,
        };
        return;
      }
      yield ProviderEventSchema.parse(event);
    }
  }
}

export type JsonLineProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Tee of every stdout line as it is read, before parsing, blank and non-JSON
   * lines included, without its line ending. Must not throw.
   */
  onRawStdoutLine?: (line: string) => void;
  /** Tee of every stderr chunk as it arrives. Must not throw. */
  onStderr?: (chunk: string) => void;
};
/**
 * Run a CLI that speaks JSON lines on stdout and yield each parsed line. A
 * line that is not JSON is a `protocol_warning`; stderr is kept only as the
 * last 100 KB, for the error a non-zero exit throws; stdout is bounded by
 * `maxOutputBytes`. The two tees see the raw text of both streams without
 * changing any of that.
 */
export async function* jsonLineProcess(options: JsonLineProcessOptions): AsyncGenerator<unknown> {
  if (options.signal?.aborted) {
    yield { type: 'cancelled' };
    return;
  }
  const max = options.maxOutputBytes ?? 10_000_000;
  let bytes = 0;
  let stderr = '';
  let aborted = false;
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env ?? providerChildEnvironment(),
  });
  const abort = () => {
    aborted = true;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3000).unref();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  // Decoded by the stream, so a multi-byte character split across two chunks
  // is not mangled in either the error tail or the tee.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    options.onStderr?.(chunk);
    stderr = (stderr + chunk).slice(-100_000);
  });
  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      options.onRawStdoutLine?.(line);
      bytes += Buffer.byteLength(line);
      if (bytes > max) throw new Error('Provider output exceeded limit');
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as unknown;
      } catch {
        yield { type: 'protocol_warning', raw: line };
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (value) => resolve(value ?? -1));
  });
  if (code !== 0 && !aborted) throw new Error(`Provider exited ${code}: ${stderr.trim()}`);
  if (aborted) yield { type: 'cancelled' };
}

function providerChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'PATHEXT',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'ComSpec',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'CI',
    'NODE_ENV',
    'LANG',
    'LC_ALL',
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
}

export async function executableAvailable(command: string): Promise<boolean> {
  if (command.includes('/') || command.includes('\\')) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  return new Promise((resolve) => {
    const child = spawn(locator, [command], { stdio: 'ignore', shell: false });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

export async function capture(
  command: string,
  args: string[],
  cwd = process.cwd(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Validate a provider's terminal output against the request's JSON Schema at
 * the trust boundary. A string is parsed first; anything that is not a plain
 * JSON value, or that misses the schema, is an error the adapter reports as
 * `STRUCTURED_OUTPUT_INVALID` rather than a completion. Covers the subset of
 * JSON Schema the pipeline's own schemas use (type, enum, const, required,
 * properties, additionalProperties, items, min/max, allOf/anyOf/oneOf).
 */
export function parseStructuredOutput(
  output: unknown,
  schema: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { ok: false, error: 'Provider terminal output was not valid JSON' };
    }
  }
  if (!isJsonValue(value))
    return { ok: false, error: 'Provider terminal output was not a JSON value' };
  const error = validateJsonSchema(value, schema, '$');
  return error ? { ok: false, error } : { ok: true, value };
}

function validateJsonSchema(value: unknown, schema: unknown, path: string): string | undefined {
  if (schema === true) return undefined;
  if (schema === false) return `${path} is rejected by the output schema`;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return `${path} has an invalid output schema`;
  const rule = schema as Record<string, unknown>;
  if (Array.isArray(rule.allOf)) {
    for (const branch of rule.allOf) {
      const error = validateJsonSchema(value, branch, path);
      if (error) return error;
    }
  }
  if (Array.isArray(rule.anyOf)) {
    const errors = rule.anyOf.map((branch) => validateJsonSchema(value, branch, path));
    if (errors.every(Boolean)) return `${path} does not match any allowed schema`;
  }
  if (Array.isArray(rule.oneOf)) {
    const matches = rule.oneOf.filter((branch) => !validateJsonSchema(value, branch, path));
    if (matches.length !== 1) return `${path} must match exactly one allowed schema`;
  }
  if ('const' in rule && !isJsonEqual(value, rule.const)) return `${path} does not match const`;
  if (Array.isArray(rule.enum) && !rule.enum.some((item) => isJsonEqual(value, item)))
    return `${path} is not an allowed value`;
  const types = Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : [];
  if (types.length > 0 && !types.some((type) => matchesType(value, type)))
    return `${path} must be ${types.join(' or ')}`;
  if (typeof value === 'string') {
    if (typeof rule.minLength === 'number' && value.length < rule.minLength)
      return `${path} is shorter than minLength`;
    if (typeof rule.maxLength === 'number' && value.length > rule.maxLength)
      return `${path} is longer than maxLength`;
  }
  if (typeof value === 'number') {
    if (typeof rule.minimum === 'number' && value < rule.minimum) return `${path} is below minimum`;
    if (typeof rule.maximum === 'number' && value > rule.maximum) return `${path} is above maximum`;
  }
  if (Array.isArray(value) && rule.items !== undefined) {
    for (const [index, item] of value.entries()) {
      const error = validateJsonSchema(item, rule.items, `${path}[${index}]`);
      if (error) return error;
    }
  }
  if (isRecord(value)) {
    const required = Array.isArray(rule.required) ? rule.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) return `${path}.${key} is required`;
    }
    const properties = isRecord(rule.properties) ? rule.properties : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        const error = validateJsonSchema(value[key], propertySchema, `${path}.${key}`);
        if (error) return error;
      }
    }
    if (rule.additionalProperties === false) {
      const unexpected = Object.keys(value).find((key) => !(key in properties));
      if (unexpected) return `${path}.${unexpected} is not allowed`;
    }
  }
  return undefined;
}

function matchesType(value: unknown, type: unknown): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof type === 'string' && typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function isJsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
