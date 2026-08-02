import { describe, expect, it, vi } from 'vitest';

import {
  formatDeepResearchFooter,
  formatDeepResearchTranscript,
  handleDeepResearchCommand,
} from '#/tui/commands/deep-research';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { DeepResearchResult } from '@moonshot-ai/kimi-code-sdk';

function makeResult(overrides: Partial<DeepResearchResult> = {}): DeepResearchResult {
  return {
    status: 'verified',
    report:
      '# Research result\n\n**Status: Verified**\n\nBody.\n\n## Sources\n'
      + '- [S1] Example Source — https://example.com/a\n'
      + '- [S2] Verifier Source — https://example.com/b (independently checked against https://example.com/b)\n\n'
      + '## Coverage and uncertainty\n- none',
    chatReport: 'Chat body with [S1].',
    reportPath: '/tmp/report.md',
    verifiedClaimIds: ['c1'],
    coverageNotes: [],
    questions: ['q1'],
    runId: 'abcd1234',
    ...overrides,
  };
}

function makeHost(options: {
  model?: string;
  hasSession?: boolean;
  startDeepResearch?: ReturnType<typeof vi.fn>;
} = {}) {
  const startDeepResearch =
    options.startDeepResearch ??
    vi.fn(async () => makeResult());
  const session =
    options.hasSession === false
      ? undefined
      : {
          startDeepResearch,
        };

  const appState = {
    model: options.model ?? 'kimi-model',
    streamingPhase: 'idle' as 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell',
  };

  const host = {
    state: {
      appState,
      transcriptEntries: [] as unknown[],
    },
    session,
    track: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    beginSessionRequest: vi.fn(() => {
      appState.streamingPhase = 'waiting';
    }),
    failSessionRequest: vi.fn((message: string) => {
      appState.streamingPhase = 'idle';
      host.showError(message);
    }),
    setAppState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(appState, patch);
    }),
    resetLivePane: vi.fn(),
  } as unknown as SlashCommandHost;

  return { host, session, startDeepResearch, appState };
}

describe('handleDeepResearchCommand', () => {
  it('rejects empty query without starting research', async () => {
    const { host, startDeepResearch } = makeHost();
    await handleDeepResearchCommand(host, '   ');
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Provide a research query'),
    );
    expect(startDeepResearch).not.toHaveBeenCalled();
    expect(host.beginSessionRequest).not.toHaveBeenCalled();
  });

  it('marks the session busy for the whole run and clears it after success', async () => {
    let resolveRun: (value: DeepResearchResult) => void = () => {};
    const startDeepResearch = vi.fn(
      () =>
        new Promise<DeepResearchResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const { host, appState } = makeHost({ startDeepResearch });

    const pending = handleDeepResearchCommand(host, 'Compare X and Y');
    // beginSessionRequest must fire before the await settles.
    expect(host.beginSessionRequest).toHaveBeenCalledOnce();
    expect(appState.streamingPhase).toBe('waiting');
    expect(host.appendTranscriptEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user',
        content: '/deep-research Compare X and Y',
      }),
    );

    resolveRun(makeResult());
    await pending;

    expect(appState.streamingPhase).toBe('idle');
    expect(host.resetLivePane).toHaveBeenCalled();
    expect(host.appendTranscriptEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'assistant',
        renderMode: 'markdown',
        modelText: false,
      }),
    );
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Deep research · Verified'),
    );
  });

  it('clears busy on cancel and posts a cancelled status entry', async () => {
    const startDeepResearch = vi.fn(async () =>
      makeResult({ status: 'cancelled', chatReport: '', reportPath: null }),
    );
    const { host, appState } = makeHost({ startDeepResearch });

    await handleDeepResearchCommand(host, 'query');

    expect(host.beginSessionRequest).toHaveBeenCalledOnce();
    expect(appState.streamingPhase).toBe('idle');
    expect(host.resetLivePane).toHaveBeenCalled();
    expect(host.appendTranscriptEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'status',
        content: 'Deep research was cancelled.',
      }),
    );
  });

  it('uses failSessionRequest on error and ends idle', async () => {
    const startDeepResearch = vi.fn(async () => {
      throw new Error('boom');
    });
    const { host, appState } = makeHost({ startDeepResearch });

    await handleDeepResearchCommand(host, 'query');

    expect(host.failSessionRequest).toHaveBeenCalledWith(
      expect.stringContaining('Deep research failed: boom'),
    );
    expect(appState.streamingPhase).toBe('idle');
  });
});

describe('formatDeepResearchTranscript / footer', () => {
  it('formats a transcript body with report path', () => {
    const text = formatDeepResearchTranscript(makeResult());
    expect(text).toContain('# Deep research · Verified');
    expect(text).toContain('Chat body with [S1].');
    expect(text).toContain('**Full report:** `/tmp/report.md`');
  });

  it('attaches the Sources lookup section so [Sn] markers are readable in place', () => {
    const text = formatDeepResearchTranscript(makeResult());
    expect(text).toContain('## Sources');
    expect(text).toContain('- [S1] Example Source — https://example.com/a');
    expect(text).toContain('- [S2] Verifier Source — https://example.com/b');
  });

  it('omits the Sources section when the report has none', () => {
    const text = formatDeepResearchTranscript(
      makeResult({
        report: '# Research result\n\n**Status: Partial**\n\nNo claims.\n\n## Coverage and uncertainty\n- gap',
      }),
    );
    expect(text).not.toContain('## Sources');
  });

  it('formats a short footer status', () => {
    expect(formatDeepResearchFooter(makeResult())).toBe(
      'Deep research · Verified · full report saved',
    );
    expect(
      formatDeepResearchFooter(makeResult({ reportPath: null, status: 'partial' })),
    ).toBe('Deep research · Partial');
  });
});
