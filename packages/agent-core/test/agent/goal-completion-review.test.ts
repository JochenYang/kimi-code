import { describe, expect, it } from 'vitest';

import {
  formatCompletionReviewFailure,
  parseCompletionReviewOutput,
} from '../../src/agent/goal/completion-review';

describe('parseCompletionReviewOutput', () => {
  it('accepts a clean pass', () => {
    const result = parseCompletionReviewOutput(
      JSON.stringify({
        passed: true,
        evidence: 'npm test exited 0; src/auth matches the migration checklist.',
        gaps: [],
      }),
    );
    expect(result.passed).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.evidence).toContain('npm test');
  });

  it('rejects pass without evidence', () => {
    const result = parseCompletionReviewOutput(
      JSON.stringify({ passed: true, evidence: '', gaps: [] }),
    );
    expect(result.passed).toBe(false);
    expect(result.gaps.some((g) => g.includes('without concrete evidence'))).toBe(true);
  });

  it('rejects pass that still lists gaps', () => {
    const result = parseCompletionReviewOutput(
      JSON.stringify({
        passed: true,
        evidence: 'tests green',
        gaps: ['docs still TODO'],
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.gaps.some((g) => g.includes('docs still TODO'))).toBe(true);
  });

  it('parses fenced JSON failure', () => {
    const result = parseCompletionReviewOutput(
      'Here is my review:\n```json\n{"passed":false,"evidence":"todo open","gaps":["finish todo"]}\n```\n',
    );
    expect(result.passed).toBe(false);
    expect(result.gaps).toContain('finish todo');
  });

  it('fails closed on unparseable output', () => {
    const result = parseCompletionReviewOutput('looks done to me');
    expect(result.passed).toBe(false);
    expect(result.gaps[0]).toMatch(/unparseable/i);
  });
});

describe('formatCompletionReviewFailure', () => {
  it('lists gaps for the implementer and keeps the goal active', () => {
    const text = formatCompletionReviewFailure({
      passed: false,
      evidence: 'rg still finds FIXME',
      gaps: ['remove FIXME in src/a.ts'],
    });
    expect(text).toContain('Completion review did not pass');
    expect(text).toContain('goal remains active');
    expect(text).toContain('remove FIXME in src/a.ts');
    expect(text).toContain('rg still finds FIXME');
    expect(text).toContain('Do not immediately re-call');
  });
});
