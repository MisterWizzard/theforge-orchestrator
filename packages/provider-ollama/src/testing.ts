import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An in-process fake of the Ollama HTTP API for tests: `/api/version`,
 * `/api/tags`, `/api/ps`, `/api/show` and a scriptable streaming `/api/chat`.
 * Unit tests never touch the real server, which may be mid-benchmark.
 */

export type FakeOllamaModel = {
  name: string;
  size?: number;
  family?: string;
  /** What `/api/show` reports; `thinking` is what the adapter looks for. */
  capabilities?: string[];
};

export type FakeOllamaLoadedModel = {
  name: string;
  sizeVram: number;
  contextLength: number;
  expiresAt?: string;
};

export type FakeOllamaChatBehaviour =
  /** Stream each chunk as a content delta, then the final chunk with the counts. */
  | {
      kind: 'stream';
      chunks: string[];
      promptEvalCount?: number;
      evalCount?: number;
      doneReason?: string;
      /** Pause between chunks, so a test can abort mid-stream. */
      delayMs?: number;
    }
  /** Refuse with an HTTP status and an Ollama-style `{error}` body. */
  | { kind: 'status'; status: number; error: string }
  /** Stream some content, then an `{error}` line instead of the final chunk. */
  | { kind: 'error_chunk'; error: string; before?: string[] }
  /** Stream content until roughly this many bytes have gone out, then finish. */
  | { kind: 'flood'; bytes: number }
  /** Send headers and then nothing, until the client goes away. */
  | { kind: 'hang' }
  /** Stream the chunks and close without a final chunk. */
  | { kind: 'truncated'; chunks: string[] };

export type FakeOllamaOptions = {
  version?: string;
  models?: FakeOllamaModel[];
  loaded?: FakeOllamaLoadedModel[];
  chat?: FakeOllamaChatBehaviour | ((body: Record<string, unknown>) => FakeOllamaChatBehaviour);
};

export type FakeOllamaRequest = { method: string; path: string; body: unknown };

export type FakeOllama = {
  url: string;
  /** Every request received, in order. */
  requests: FakeOllamaRequest[];
  /** The body of every `POST /api/chat`, in order. */
  chats: Record<string, unknown>[];
  /** Chat responses whose client went away before the stream finished. */
  readonly abortedChats: number;
  close(): Promise<void>;
};

const DEFAULT_MODELS: FakeOllamaModel[] = [
  { name: 'qwen3:8b', family: 'qwen3', capabilities: ['completion', 'tools', 'thinking'] },
  { name: 'devstral-small-2:latest', family: 'mistral3', capabilities: ['completion', 'tools'] },
];

export async function startFakeOllama(options: FakeOllamaOptions = {}): Promise<FakeOllama> {
  const requests: FakeOllamaRequest[] = [];
  const chats: Record<string, unknown>[] = [];
  const models = options.models ?? DEFAULT_MODELS;
  const loaded = options.loaded ?? [];
  const version = options.version ?? '0.34.4';
  const state = { abortedChats: 0 };

  const json = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };

  const chatLine = (model: string, content: string, done: false) =>
    `${JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content }, done })}\n`;
  const doneLine = (
    model: string,
    promptEvalCount: number,
    evalCount: number,
    doneReason: string,
  ) =>
    `${JSON.stringify({
      model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      done_reason: doneReason,
      done: true,
      total_duration: 1_000_000,
      load_duration: 0,
      prompt_eval_count: promptEvalCount,
      prompt_eval_duration: 1_000,
      eval_count: evalCount,
      eval_duration: 1_000,
    })}\n`;

  const write = async (response: ServerResponse, data: string) => {
    if (!response.write(data)) await once(response, 'drain');
  };

  async function chat(response: ServerResponse, body: Record<string, unknown>) {
    const model = typeof body.model === 'string' ? body.model : '';
    if (!models.some((candidate) => candidate.name === model)) {
      json(response, 404, { error: `model '${model}' not found` });
      return;
    }
    const behaviour =
      typeof options.chat === 'function'
        ? options.chat(body)
        : (options.chat ?? { kind: 'stream', chunks: ['ok'] });
    if (behaviour.kind === 'status') {
      json(response, behaviour.status, { error: behaviour.error });
      return;
    }
    let finished = false;
    let closed = false;
    response.on('close', () => {
      closed = true;
      if (!finished) state.abortedChats += 1;
    });
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.flushHeaders();
    if (behaviour.kind === 'hang') return;
    if (behaviour.kind === 'flood') {
      const filler = 'a'.repeat(60_000);
      let sent = 0;
      while (sent < behaviour.bytes && !closed) {
        const line = chatLine(model, filler, false);
        sent += line.length;
        await write(response, line);
      }
      if (closed) return;
      finished = true;
      response.end(doneLine(model, 1, 1, 'stop'));
      return;
    }
    const chunks = behaviour.kind === 'error_chunk' ? (behaviour.before ?? []) : behaviour.chunks;
    const delayMs = behaviour.kind === 'stream' ? (behaviour.delayMs ?? 0) : 0;
    for (const chunk of chunks) {
      if (closed) return;
      await write(response, chatLine(model, chunk, false));
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (closed) return;
    finished = true;
    if (behaviour.kind === 'truncated') {
      response.end();
      return;
    }
    if (behaviour.kind === 'error_chunk') {
      response.end(`${JSON.stringify({ error: behaviour.error })}\n`);
      return;
    }
    response.end(
      doneLine(
        model,
        behaviour.promptEvalCount ?? 0,
        behaviour.evalCount ?? 0,
        behaviour.doneReason ?? 'stop',
      ),
    );
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', 'http://fake').pathname;
    const raw = await readBody(request);
    let body: unknown;
    try {
      body = raw ? (JSON.parse(raw) as unknown) : undefined;
    } catch {
      body = raw;
    }
    requests.push({ method, path, body });
    const record = isRecord(body) ? body : {};
    switch (`${method} ${path}`) {
      case 'GET /api/version':
        return json(response, 200, { version });
      case 'GET /api/tags':
        return json(response, 200, {
          models: models.map((model) => ({
            name: model.name,
            model: model.name,
            size: model.size ?? 1_000_000,
            details: {
              family: model.family ?? 'test',
              parameter_size: '1B',
              quantization_level: 'Q4_K_M',
            },
          })),
        });
      case 'GET /api/ps':
        return json(response, 200, {
          models: loaded.map((model) => ({
            name: model.name,
            model: model.name,
            size: model.sizeVram,
            size_vram: model.sizeVram,
            context_length: model.contextLength,
            ...(model.expiresAt ? { expires_at: model.expiresAt } : {}),
          })),
        });
      case 'POST /api/show': {
        const name = typeof record.model === 'string' ? record.model : '';
        const model = models.find((candidate) => candidate.name === name);
        if (!model) return json(response, 404, { error: `model '${name}' not found` });
        return json(response, 200, {
          capabilities: model.capabilities ?? ['completion'],
          details: { family: model.family ?? 'test' },
        });
      }
      case 'POST /api/chat':
        chats.push(record);
        return chat(response, record);
      default:
        return json(response, 404, { error: 'not found' });
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    chats,
    get abortedChats() {
      return state.abortedChats;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
