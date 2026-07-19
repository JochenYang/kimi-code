/**
 * Scenario: structured compaction handoff validation and working-set evidence.
 *
 * Responsibilities: assert required sections, placeholder normalization, and
 * failure evidence extraction from real ContextMessage history shapes.
 * Wiring: pure helpers. Run:
 * vitest run test/agent/fullCompaction/handoffStructure.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  extractWorkingSetEvidence,
  validateHandoffStructure,
} from '#/agent/fullCompaction/handoffStructure';
import type { ContextMessage } from '#/agent/contextMemory/types';

function user(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
}

function toolError(id: string, name: string, text: string): ContextMessage {
  return {
    role: 'tool',
    name,
    toolCallId: id,
    isError: true,
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

describe('validateHandoffStructure', () => {
  it('accepts summaries with required section headings', () => {
    const summary = [
      '## Intent',
      'Ship phase 0 telemetry',
      '## Constraints',
      'v2 only',
      '## Done',
      'helpers added',
      '## Open questions',
      'none',
      '## Next plan',
      'run tests',
    ].join('\n');
    const result = validateHandoffStructure(summary);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.normalizedSummary).toBe(summary);
  });

  it('fills missing sections with placeholders without inventing facts', () => {
    const result = validateHandoffStructure('kept working on the bug');
    expect(result.ok).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.normalizedSummary).toContain('kept working on the bug');
    expect(result.normalizedSummary).toContain('## Intent');
    expect(result.normalizedSummary).toContain('## Next plan');
  });
});

describe('extractWorkingSetEvidence', () => {
  it('retains tool error excerpts for post-compaction injection', () => {
    const history: ContextMessage[] = [
      user('fix the test'),
      toolError('call_1', 'Bash', 'Error: command failed with exit 1\nAssertionError: expected green'),
      user('continue'),
    ];
    const evidence = extractWorkingSetEvidence(history);
    expect(evidence.items.length).toBeGreaterThanOrEqual(1);
    expect(evidence.items[0]?.kind).toBe('tool_error');
    expect(evidence.injectionText).toContain('Working-set evidence');
    expect(evidence.injectionText).toContain('AssertionError');
  });

  it('returns no injection when history has no failure evidence', () => {
    const evidence = extractWorkingSetEvidence([user('hello'), user('thanks')]);
    expect(evidence.items).toEqual([]);
    expect(evidence.injectionText).toBeUndefined();
  });
});
