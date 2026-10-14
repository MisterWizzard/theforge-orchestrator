import { Redis } from 'ioredis';

export type QueueHint = { taskId: string; enqueuedAt: string };
export interface TaskQueue {
  push(taskId: string): Promise<void>;
  pop(timeoutSeconds?: number): Promise<QueueHint | undefined>;
  close(): Promise<void>;
}

export class MemoryTaskQueue implements TaskQueue {
  private readonly items: QueueHint[] = [];
  async push(taskId: string) {
    this.items.push({ taskId, enqueuedAt: new Date().toISOString() });
  }
  async pop() {
    return this.items.shift();
  }
  async close() {}
}

export class RedisTaskQueue implements TaskQueue {
  private readonly redis: Redis;
  constructor(
    url = process.env.REDIS_URL,
    private readonly key = 'theforge:ready',
  ) {
    if (!url) throw new Error('REDIS_URL is required');
    this.redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
  }
  async push(taskId: string) {
    await this.redis.lpush(
      this.key,
      JSON.stringify({ taskId, enqueuedAt: new Date().toISOString() } satisfies QueueHint),
    );
  }
  async pop(timeoutSeconds = 1) {
    if (timeoutSeconds <= 0) {
      const item = await this.redis.rpop(this.key);
      return item ? parseQueueHint(item) : undefined;
    }
    const item = await this.redis.brpop(this.key, timeoutSeconds);
    return item ? parseQueueHint(item[1]) : undefined;
  }
  async close() {
    await this.redis.quit();
  }
}

function parseQueueHint(value: string): QueueHint | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const hint = parsed as Record<string, unknown>;
    if (
      typeof hint.taskId !== 'string' ||
      !hint.taskId ||
      typeof hint.enqueuedAt !== 'string' ||
      Number.isNaN(Date.parse(hint.enqueuedAt))
    )
      return undefined;
    return { taskId: hint.taskId, enqueuedAt: hint.enqueuedAt };
  } catch {
    return undefined;
  }
}

export async function checkRedis(url = process.env.REDIS_URL): Promise<'ok' | 'unconfigured'> {
  if (!url) return 'unconfigured';
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    const response: string = await redis.ping();
    if (response !== 'PONG') throw new Error(`Unexpected Redis health response: ${response}`);
    return 'ok';
  } finally {
    await redis.quit().catch(() => redis.disconnect());
  }
}
