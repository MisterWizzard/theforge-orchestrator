import { describe, expect, it } from 'vitest';
import type { ProviderRequest } from '@theforge/contracts';
import { buildOllamaMessages, PLAYBOOKS } from './index.js';

const request = (role: ProviderRequest['role']): ProviderRequest => ({
  runId: 'r',
  taskId: 't',
  role,
  prompt: 'Plan this.',
  context: [],
  timeoutMs: 1000,
});

describe('role playbooks (ADR-045)', () => {
  it('leaves the system message exactly as before when playbooks are off', () => {
    const [off] = buildOllamaMessages(request('planner'));
    const [explicitOff] = buildOllamaMessages(request('planner'), { playbooks: false });
    expect(off!.content).toBe(explicitOff!.content);
    expect(off!.content).not.toContain('How to write the plan');
  });

  it('appends the planner and critic playbooks when they are on', () => {
    const [planner] = buildOllamaMessages(request('planner'), { playbooks: true });
    const [critic] = buildOllamaMessages(request('critic'), { playbooks: true });
    expect(planner!.content.endsWith(PLAYBOOKS.planner!)).toBe(true);
    expect(critic!.content.endsWith(PLAYBOOKS.critic!)).toBe(true);
  });

  it('adds nothing for a role without a playbook', () => {
    const [on] = buildOllamaMessages(request('builder'), { playbooks: true });
    const [off] = buildOllamaMessages(request('builder'));
    expect(on!.content).toBe(off!.content);
  });

  it("keeps the planner playbook on the pipeline's headings and the test-only rule", () => {
    expect(PLAYBOOKS.planner).toContain(
      'Acceptance criteria, File ownership, Steps, Risks, Checks',
    );
    expect(PLAYBOOKS.planner).toContain('only test files may change');
  });
});
