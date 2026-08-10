/**
 * DeepResearchOrchestrator unit tests with a fake host.
 * Tests the phase sequencing, schema validation, budget enforcement,
 * partial-result aggregation, and report building in isolation.
 */

import { describe, expect, it } from 'vitest';

import { DeepResearchOrchestrator } from '#/session/deepResearch/orchestrator';
import { buildFullReport, linkCitations } from '#/session/deepResearch/report-builder';
import {
  DEEP_RESEARCH_HANDOFF_SUMMARY_CHARS,
  formatDeepResearchHandoff,
} from '#/session/deepResearch/handoff';
import type {
  DeepResearchHost,
  DeepResearchAgentCall,
  DeepResearchAgentOutcome,
  DeepResearchProgress,
  DeepResearchResult,
} from '#/session/deepResearch/types';

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
    onProgress: (p: DeepResearchProgress) => {
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
    expect(result.coverageNotes.some((n: string) => n.includes('planner failed'))).toBe(true);
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
    // Citations in the body link straight to their source URL.
    expect(result.report).toContain('[S1](<https://example.com/default>)');
    expect(result.report).toContain('[S2](<https://example.com/default>)');
    // The Sources section is a clean one-entry-per-line list: no verifier
    // process noise, no "independently checked" follow-up lines.
    expect(result.report).not.toContain('independently checked');
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

describe('report builder', () => {
  const claims: readonly import('#/session/deepResearch/types').VerifiedClaim[] = [
    {
      id: 'c1',
      claim: 'Claim 1',
      original_evidence: 'Evidence 1',
      original_source_title: 'Source 1',
      original_source_locator: 'https://example.com/a',
      verifier_evidence: 'Verified 1',
      verifier_source_title: 'Source 1 (verified)',
      verifier_source_locator: 'https://example.com/a-verified',
      verifier_note: '',
    },
    {
      id: 'c2',
      claim: 'Claim 2',
      original_evidence: 'Evidence 2',
      original_source_title: 'Source 2',
      original_source_locator: 'https://example.com/b',
      verifier_evidence: 'Verified 2',
      verifier_source_title: 'Source 2 (verified)',
      verifier_source_locator: 'https://example.com/b-verified',
      verifier_note: '',
    },
  ];

  it('turns known [Sn] markers into source links and leaves unknown ones alone', () => {
    const linked = linkCitations(
      'Facts from [S1] and [S2]; invented [S9] stays.',
      new Map([
        ['S1', 'https://example.com/a'],
        ['S2', 'https://example.com/b'],
      ]),
    );
    expect(linked).toBe(
      'Facts from [S1](<https://example.com/a>) and [S2](<https://example.com/b>); invented [S9] stays.',
    );
  });

  it('builds a clean Sources list without verifier follow-up noise', () => {
    const report = buildFullReport({
      status: 'verified',
      body: 'Body [S1].',
      verifiedClaims: claims,
      coverageNotes: [],
    });
    expect(report).toContain('## Sources');
    expect(report).toContain('- [S1] Source 1\n  https://example.com/a\n');
    expect(report).toContain('- [S2] Source 2\n  https://example.com/b\n');
    expect(report).not.toContain('independently checked');
    expect(report).not.toContain('verifier_source');
  });

  it('groups Question N uncertainty notes under per-question headings', () => {
    const report = buildFullReport({
      status: 'partial',
      body: 'Body.',
      verifiedClaims: claims,
      coverageNotes: [
        'Question 1 uncertainty: gap one',
        'Question 2 uncertainty: gap two a',
        'Question 2 uncertainty: gap two b',
        'The planner failed; researching the original query as one question.',
      ],
    });
    expect(report).toContain('### Question 1\n- gap one\n');
    expect(report).toContain('### Question 2\n- gap two a\n- gap two b\n');
    expect(report).toContain('- The planner failed; researching the original query as one question.\n');
  });
});
