/**
 * DeepResearchOrchestrator unit tests with a fake host.
 * Tests the phase sequencing, schema validation, budget enforcement,
 * partial-result aggregation, and report building in isolation.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DeepResearchOrchestrator,
  formatDeepResearchHandoff,
  DEEP_RESEARCH_HANDOFF_SUMMARY_CHARS,
} from '../../src/agent/deep-research';
import type {
  DeepResearchHost,
  DeepResearchAgentCall,
  DeepResearchAgentOutcome,
  DeepResearchProgress,
  DeepResearchResult,
} from '../../src/agent/deep-research';

// ── Fake host ────────────────────────────────────────────────────────────────

function makePlanResult(questions: string[]): DeepResearchAgentOutcome {
  return {
    success: true,
    output: JSON.stringify({ questions }),
  };
}

function makeResearchResult(
  claims: Array<{
    claim: string;
    evidence: string;
    source_title: string;
    source_locator: string;
    source_type?: 'primary' | 'secondary' | 'repository' | 'other';
    confidence?: 'high' | 'medium' | 'low';
  }>,
  uncertainties: string[] = [],
): DeepResearchAgentOutcome {
  return {
    success: true,
    output: JSON.stringify({
      claims: claims.map((c) => ({
        claim: c.claim,
        evidence: c.evidence,
        source_title: c.source_title,
        source_locator: c.source_locator,
        source_type: c.source_type ?? 'primary',
        confidence: c.confidence ?? 'high',
      })),
      uncertainties,
    }),
  };
}

function makeVerifyResult(
  verdicts: Array<{
    claim_id: string;
    supported: boolean;
    reason: string;
    evidence?: string;
    source_title?: string;
    source_locator?: string;
  }>,
): DeepResearchAgentOutcome {
  return {
    success: true,
    output: JSON.stringify({ verdicts }),
  };
}

function makeFakeHost(
  options: {
    plan?: DeepResearchAgentOutcome;
    research?: DeepResearchAgentOutcome[];
    verifies?: DeepResearchAgentOutcome[];
    synthesize?: DeepResearchAgentOutcome;
    writeReport?: string;
  } = {},
): DeepResearchHost {
  let callIndex = 0;
  const progress: DeepResearchProgress[] = [];

  return {
    onProgress: (p) => {
      progress.push(p);
    },

    runAgent: async (call: DeepResearchAgentCall, _signal: AbortSignal): Promise<DeepResearchAgentOutcome> => {
      callIndex++;
      if (call.phase === 'Plan') {
        return options.plan ?? makePlanResult(['Question 1', 'Question 2']);
      }
      if (call.phase === 'Report') {
        return options.synthesize ?? {
          success: true,
          output: '<report-body>\nDirect answer here.\n\n### Section 1\n\nFinding [S1] and [S2].\n</report-body>',
        };
      }
      return { success: true, output: '{}' };
    },

    runParallel: async (calls: readonly DeepResearchAgentCall[], _signal: AbortSignal): Promise<readonly DeepResearchAgentOutcome[]> => {
      callIndex++;
      if (calls.length > 0 && calls[0]?.phase === 'Research') {
        const preset = options.research;
        if (preset !== undefined) {
          // Pad with fallback failures to match call count
          return calls.map((_, i) => preset[i] ?? { success: false, output: '', error: 'No preset result' });
        }
        return calls.map(() => makeResearchResult([
          {
            claim: 'Default claim',
            evidence: 'Evidence text',
            source_title: 'Default Source',
            source_locator: 'https://example.com/default',
          },
        ]));
      }
      if (calls.length > 0 && calls[0]?.phase === 'Verify') {
        const preset = options.verifies;
        if (preset !== undefined) {
          return calls.map((_, i) => preset[i] ?? makeVerifyResult([]));
        }
        // Default: match candidate claims by index. Each call gets its expected claims.
        return calls.map((_, i) => makeVerifyResult([
          {
            claim_id: `claim-${i}`,
            supported: true,
            reason: 'Verified',
            evidence: 'Confirmed',
            source_title: 'Verified Source',
            source_locator: 'https://example.com/v1',
          },
        ]));
      }
      return calls.map(() => ({ success: true, output: '' }));
    },

    writeReport: async (_runId: string, _markdown: string): Promise<string> => {
      return options.writeReport ?? '/tmp/report.md';
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DeepResearchOrchestrator', () => {
  it('runs plan → research → verify → report for a basic query', async () => {
    const host = makeFakeHost();
    const orchestrator = new DeepResearchOrchestrator({ query: 'test query' }, host);
    const result = await orchestrator.run(new AbortController().signal);

    expect(result.status).toBe('verified');
    expect(result.chatReport.length).toBeGreaterThan(0);
    expect(result.reportPath).toBe('/tmp/report.md');
    expect(result.verifiedClaimIds.length).toBe(2);
    expect(result.verifiedClaimIds).toEqual(['claim-0', 'claim-1']);
  });

  it('marks status as partial when a research question returns no output', async () => {
    const host = makeFakeHost({
      research: [{
        success: false,
        output: '',
        error: 'Failed to research',
      }],
    });
    const orchestrator = new DeepResearchOrchestrator({ query: 'test query' }, host);
    const result = await orchestrator.run(new AbortController().signal);

    expect(result.status).toBe('partial');
    expect(result.coverageNotes.length).toBeGreaterThan(0);
    expect(result.verifiedClaimIds.length).toBe(0);
  });

  it('reports partial when all claims are rejected by verifier', async () => {
    const host = makeFakeHost({
      verifies: [
        makeVerifyResult([
          { claim_id: 'claim-0', supported: false, reason: 'No evidence found' },
          { claim_id: 'claim-1', supported: false, reason: 'Source unreliable' },
        ]),
      ],
    });
    const orchestrator = new DeepResearchOrchestrator({ query: 'test query' }, host);
    const result = await orchestrator.run(new AbortController().signal);

    expect(result.status).toBe('partial');
    expect(result.verifiedClaimIds.length).toBe(0);
  });

  it('falls back to deterministic findings when synthesis fails citation validation', async () => {
    const host = makeFakeHost({
      synthesize: {
        success: true,
        output: '<report-body>\nBad report with no markers.\n</report-body>',
      },
    });
    const orchestrator = new DeepResearchOrchestrator({ query: 'test query' }, host);
    const result = await orchestrator.run(new AbortController().signal);

    expect(result.status).toBe('verified');
    // Should contain the deterministic fallback with "## Findings"
    expect(result.chatReport).toContain('Default claim');
  });

  it('uses a single question when the planner fails', async () => {
    const host = makeFakeHost({
      plan: { success: false, output: '', error: 'Planner error' },
    });
    const orchestrator = new DeepResearchOrchestrator({ query: 'test query' }, host);
    const result = await orchestrator.run(new AbortController().signal);

    expect(result.status).toBe('partial');
    expect(result.coverageNotes.some((n) => n.includes('planner failed'))).toBe(true);
  });

  it('respects abort signal and returns cancelled', async () => {
    const controller = new AbortController();
    const host = makeFakeHost({
      plan: {
        success: true,
        output: JSON.stringify({ questions: ['Q1', 'Q2', 'Q3', 'Q4'] }),
      },
    });
    // Abort before research starts
    controller.abort();
    const orchestrator = new DeepResearchOrchestrator({ query: 'test query' }, host);
    const result = await orchestrator.run(controller.signal);

    expect(result.status).toBe('cancelled');
  });

  it('clamps breadth to valid range', async () => {
    const host = makeFakeHost();
    const orchestrator = new DeepResearchOrchestrator({ query: 'test', breadth: 10 }, host);
    const result = await orchestrator.run(new AbortController().signal);
    // Should still work (breadth clamped to 6)
    expect(result.status).toBe('verified');
  });

  it('handles total failure gracefully', async () => {
    const host = makeFakeHost({
      plan: { success: false, output: '', error: 'Planner error' },
      research: [{
        success: false,
        output: '',
        error: 'All research failed',
      }],
    });
    const orchestrator = new DeepResearchOrchestrator({ query: 'test query' }, host);
    const result = await orchestrator.run(new AbortController().signal);

    expect(result.status).toBe('partial');
    // Should have a meaningful fallback report
    expect(result.report).toContain('Partial');
  });

  it('produces a report with Sources section', async () => {
    const host = makeFakeHost();
    const orchestrator = new DeepResearchOrchestrator({ query: 'test query' }, host);
    const result = await orchestrator.run(new AbortController().signal);

    expect(result.report).toContain('## Sources');
    expect(result.report).toContain('[S1]');
    expect(result.report).toContain('[S2]');
  });

  it('produces a report with Coverage section', async () => {
    const host = makeFakeHost();
    const orchestrator = new DeepResearchOrchestrator({ query: 'test query' }, host);
    const result = await orchestrator.run(new AbortController().signal);

    expect(result.report).toContain('## Coverage and uncertainty');
  });
});

describe('formatDeepResearchHandoff', () => {
  function makeResult(overrides: Partial<DeepResearchResult> = {}): DeepResearchResult {
    return {
      status: 'verified',
      report: '# Full\n\nlong body',
      chatReport: 'Short cited summary [S1].',
      reportPath: '/tmp/session/deep-research/abcd/report.md',
      verifiedClaimIds: ['c1'],
      coverageNotes: [],
      questions: ['q1'],
      runId: 'abcd1234',
      ...overrides,
    };
  }

  it('includes query, status, summary, and report path for follow-up Read', () => {
    const text = formatDeepResearchHandoff(makeResult(), 'Compare X and Y');
    expect(text).toContain('Deep research finished');
    expect(text).toContain('Query: Compare X and Y');
    expect(text).toContain('Status: verified');
    expect(text).toContain('Short cited summary [S1].');
    expect(text).toContain('Full report path: /tmp/session/deep-research/abcd/report.md');
    expect(text).toContain('Read tool');
  });

  it('mentions coverage note count when present', () => {
    const text = formatDeepResearchHandoff(
      makeResult({ status: 'partial', coverageNotes: ['gap a', 'gap b'] }),
      'query',
    );
    expect(text).toContain('Status: partial');
    expect(text).toContain('2 coverage note(s)');
  });

  it('truncates a long chatReport and points at the full report', () => {
    const long = 'x'.repeat(DEEP_RESEARCH_HANDOFF_SUMMARY_CHARS + 50);
    const text = formatDeepResearchHandoff(makeResult({ chatReport: long }), 'q');
    expect(text.length).toBeLessThan(long.length + 500);
    expect(text).toContain('…(truncated');
    expect(text).toContain('Full report path:');
  });

  it('omits path guidance when reportPath is null', () => {
    const text = formatDeepResearchHandoff(makeResult({ reportPath: null }), 'q');
    expect(text).not.toContain('Full report path:');
    expect(text).toContain('Status: verified');
  });
});
