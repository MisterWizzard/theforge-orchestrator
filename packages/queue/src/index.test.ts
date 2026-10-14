import { describe, expect, it } from 'vitest';
import { MemoryTaskQueue } from './index.js';

describe('queue hints', () => {
  it('treats duplicate hints as harmless wakeups', async () => {
    const queue = new MemoryTaskQueue();
    await queue.push('task-1');
    await queue.push('task-1');
    expect((await queue.pop())?.taskId).toBe('task-1');
    expect((await queue.pop())?.taskId).toBe('task-1');
    expect(await queue.pop()).toBeUndefined();
  });
});
