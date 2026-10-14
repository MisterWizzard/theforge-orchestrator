/**
 * Proof that an Anthropic API key works (ADR-038).
 *
 * The worker used to treat "an API key is configured" as "Claude is
 * authenticated". On 12/10/2026 a key that every request rejected with
 * `This API key is not scoped to a workspace` looked healthy, the planner call
 * failed, and the automatic fallback of ADR-024 ran the stage on Codex at $0 -
 * a misconfigured key was indistinguishable from a system that was merely
 * cheap. This sends the one request that settles it: a single token on the
 * cheapest model, about a thousandth of a cent.
 *
 * Only a definitive rejection counts against the key. A network error, a
 * timeout, a rate limit, a server error or an unknown model says nothing about
 * the key, so those are `inconclusive` and the provider stays advertised: a
 * blip at startup must not switch Claude off until the worker is restarted.
 */

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
/** The cheapest current model; the probe sends one token and reads none of it. */
export const KEY_PROBE_MODEL = 'claude-haiku-5-5';
export const KEY_PROBE_TIMEOUT_MS = 15_000;

export type KeyProbeResult =
  | { status: 'ok' }
  /** The API answered and refused the key (or its workspace, or its credit). */
  | { status: 'rejected'; httpStatus: number; message: string }
  /** The probe could not decide: nothing is learned about the key. */
  | { status: 'inconclusive'; message: string };

export type KeyProbeOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Sent as `anthropic-workspace-id` for a key that is not scoped to a workspace (ADR-039). */
  workspaceId?: string;
};

/** HTTP statuses that mean the API looked at the key and said no. */
const REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 403]);
const MAX_MESSAGE_CHARS = 300;

export async function probeAnthropicKey(
  apiKey: string,
  options: KeyProbeOptions = {},
): Promise<KeyProbeResult> {
  const send = options.fetch ?? fetch;
  const url = `${options.baseUrl ?? ANTHROPIC_API_URL}/v1/messages`;
  let response: Response;
  try {
    response = await send(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(options.workspaceId ? { 'anthropic-workspace-id': options.workspaceId } : {}),
      },
      body: JSON.stringify({
        model: options.model ?? KEY_PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? KEY_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: 'inconclusive',
      message: redact(`could not reach the Anthropic API: ${describe(error)}`, apiKey),
    };
  }
  if (response.ok) return { status: 'ok' };
  const message = redact(await apiErrorMessage(response), apiKey);
  if (REJECTION_STATUSES.has(response.status))
    return { status: 'rejected', httpStatus: response.status, message };
  return { status: 'inconclusive', message: `HTTP ${response.status}: ${message}` };
}

export type KeyProbeVerdict = {
  /** Whether the worker should still advertise the provider. */
  advertise: boolean;
  /** The reason to relay to the coordinator when it should not. */
  fault?: string;
  /** One line for the worker's own log. */
  log: string;
};

/** What the worker does with a probe result; kept pure so the decision is tested without Docker. */
export function keyProbeVerdict(result: KeyProbeResult): KeyProbeVerdict {
  if (result.status === 'ok')
    return { advertise: true, log: 'claude: API key verified with a one-token request' };
  if (result.status === 'inconclusive')
    return {
      advertise: true,
      log: `claude: API key could not be verified (${result.message}); advertising it anyway, a failure will show in the run`,
    };
  const fault = `the API key was rejected (HTTP ${result.httpStatus}): ${result.message}`;
  return { advertise: false, fault, log: `claude: not advertised, ${fault}` };
}

async function apiErrorMessage(response: Response): Promise<string> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return response.statusText || 'no response body';
  }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string' && parsed.error.message.trim())
      return parsed.error.message.trim();
  } catch {
    // Not JSON; the raw text is the best description there is.
  }
  return text.trim() || response.statusText || 'no response body';
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}

/** Never let the key travel in a message that reaches an event, a log or a digest. */
function redact(text: string, apiKey: string): string {
  const clean = apiKey ? text.split(apiKey).join('[redacted]') : text;
  return clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS - 1)}…` : clean;
}
