/**
 * SessionDeepResearchService unit tests with stubbed swarm / lifecycle /
 * filesystem dependencies. Verifies input validation, the swarm host
 * adapter (spawn tasks, summary-policy skip, report path), progress
 * events, cancellation, and the main-agent handoff reminder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { isError2 } from '#/errors';
import { UserCancellationError } from '#/_base/utils/abort';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionDeepResearchService,
} from '#/session/deepResearch/deepResearch';
import { SessionDeepResearchService } from '#/session/deepResearch/deepResearchService';
import { DeepResearchErrors } from '#/session/deepResearch/errors';
import type { DeepResearchResult, DeepResearchStatus } from '#/session/deepResearch/types';
import { ISessionSwarmService, type SessionSwarmRunResult, type SessionSwarmTask } from '#/session/swarm/sessionSwarm';

// ── Stub helpers ─────────────────────────────────────────────────────────────

interface MainStubs {
  readonly status: ReturnType<typeof vi.fn>;
  readonly publish: ReturnType<typeof vi.fn>;
  readonly scope: ReturnType<typeof vi.fn>;
  readonly append: ReturnType<typeof vi.fn>;
}

function makeMainHandle(stubs: MainStubs) {
  return {
    id: MAIN_AGENT_ID,
    accessor: {
      get: (id: unknown) => {
        if (id === IAgentLoopService) return { status: stubs.status };
        if (id === IEventDispatcher) return { dispatch: stubs.publish };
        if (id === IAgentScopeContext) return { agentId: MAIN_AGENT_ID, scope: stubs.scope };
        if (id === IAgentContextMemoryService) return { append: stubs.append };
        return undefined;
      },
    },
  };
}

function makePlanResult(questions: string[]): { status: 'completed'; result: string } {
  return { status: 'completed', result: JSON.stringify({ questions }) };
}

function makeResearchResult(claimIndex: number): { status: 'completed'; result: string } {
  return {
    status: 'completed',
    result: JSON.stringify({
      claims: [
        {
          claim: `Claim ${claimIndex}`,
          evidence: `Evidence ${claimIndex}`,
          source_title: `Source ${claimIndex}`,
          source_locator: `https://example.com/s${claimIndex}`,
          source_type: 'primary',
          confidence: 'high',
        },
      ],
      uncertainties: [],
    }),
  };
}

function makeVerifyResult(claimId: string): { status: 'completed'; result: string } {
  return {
    status: 'completed',
    result: JSON.stringify({
      verdicts: [
        {
          claim_id: claimId,
          supported: true,
          reason: 'Confirmed',
          evidence: 'Verifier evidence',
          source_title: 'Verifier Source',
          source_locator: 'https://example.com/v',
        },
      ],
    }),
  };
}

function makeSwarmStub() {
  const run = vi.fn(async ({ tasks }: { readonly tasks: readonly SessionSwarmTask[] }) => {
    return tasks.map((task): SessionSwarmRunResult => {
      if (task.kind !== 'spawn') return { task, status: 'failed', error: 'unexpected task kind' };
      const desc = task.description;
      if (desc === 'research-planner') return { task, status: 'completed', result: makePlanResult(['Q1', 'Q2']).result };
      const researcher = /^researcher-(\d+)$/.exec(desc);
      if (researcher !== null) return { task, status: 'completed', result: makeResearchResult(Number(researcher[1])).result };
      const verifier = /^evidence-verifier-(\d+)$/.exec(desc);
      if (verifier !== null) return { task, status: 'completed', result: makeVerifyResult(`claim-${verifier[1]}`).result };
      if (desc === 'report-synthesizer') {
        return { task, status: 'completed', result: '<report-body>\nOK [S1] [S2].\n</report-body>' };
      }
      return { task, status: 'failed', error: `unexpected description ${desc}` };
    });
  });
  const cancel = vi.fn();
  return { run, cancel };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SessionDeepResearchService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mainStubs: MainStubs;
  let swarm: ReturnType<typeof makeSwarmStub>;
  let mkdir: ReturnType<typeof vi.fn>;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    mainStubs = {
      status: vi.fn(() => ({ state: 'idle' })),
      publish: vi.fn(),
      scope: vi.fn((subKey?: string) => `sessions/abc/agents/main${subKey === undefined ? '' : `/${subKey}`}`),
      append: vi.fn(),
    };
    swarm = makeSwarmStub();
    mkdir = vi.fn(async () => {});
    writeText = vi.fn(async () => {});
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      handleOf: vi.fn(() => makeMainHandle(mainStubs)),
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionSwarmService, {
      _serviceBrand: undefined,
      run: swarm.run,
      cancel: swarm.cancel,
    } as unknown as ISessionSwarmService);
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      homeDir: '/home',
    } as unknown as IBootstrapService);
    ix.stub(IHostFileSystem, {
      _serviceBrand: undefined,
      mkdir,
      writeText,
    } as unknown as IHostFileSystem);
    ix.set(ISessionDeepResearchService, new SyncDescriptor(SessionDeepResearchService));
  });
  afterEach(() => {
    disposables.dispose();
  });

  it('runs the full pipeline and writes the report under the main agent scope', async () => {
    const svc = ix.get(ISessionDeepResearchService);
    const result = await svc.start({ query: 'Compare X and Y' });

    expect(result.status).toBe('verified');
    expect(result.questions).toEqual(['Q1', 'Q2']);
    expect(result.verifiedClaimIds).toEqual(['claim-0', 'claim-1']);
    expect(result.reportPath).toBe(
      join('/home', 'sessions/abc/agents/main/deep-research', result.runId, 'report.md'),
    );
    expect(mkdir).toHaveBeenCalledWith(
      join('/home', 'sessions/abc/agents/main/deep-research', result.runId),
      { recursive: true },
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain('deep-research');
    expect(writeText.mock.calls[0]![1]).toContain('## Sources');

    // Swarm adapter: every task is a spawn under the main agent with the
    // summary continuation skipped (structured JSON must stay short).
    for (const task of swarm.run.mock.calls[0]![0].tasks) {
      expect(task.kind).toBe('spawn');
      expect(task.profileName).toBe('explore');
      expect(task.runInBackground).toBe(false);
      expect((task as { parentToolCallId: string }).parentToolCallId).toMatch(
        /^deep-research-[0-9a-f]{8}:researcher-|research-planner|evidence-verifier-|report-synthesizer$/,
      );
    }

    // Progress events land on the main agent's event bus.
    const published = mainStubs.publish.mock.calls.map((c) => c[0] as { type: string; code?: string });
    expect(published.some((e) => e.type === 'warning' && e.code === 'deep-research-progress')).toBe(true);
    expect(published.some((e) => (e as unknown as { message: string }).message.startsWith('Deep research · Done'))).toBe(true);

    // Handoff reminder is injected into the main agent (non-cancelled runs).
    expect(mainStubs.append).toHaveBeenCalledTimes(1);
    const [message] = mainStubs.append.mock.calls[0]!;
    expect(message.origin).toEqual({ kind: 'injection', variant: 'deep_research_handoff' });
    const handoffText = (message.content as [{ type: 'text'; text: string }])[0]!.text;
    expect(handoffText).toContain('Query: Compare X and Y');
    expect(handoffText).toContain('Full report path:');
  });

  it('forwards onProgress and reports the final status', async () => {
    const svc = ix.get(ISessionDeepResearchService);
    const onProgress = vi.fn();
    const result = await svc.start({ query: 'q', onProgress });
    expect(result.status).toBe('verified');
    expect(onProgress).toHaveBeenCalled();
    const phases = onProgress.mock.calls.map((c) => (c[0] as { phase: string }).phase);
    expect(phases).toContain('Plan');
    expect(phases).toContain('Research');
    expect(phases).toContain('Verify');
    expect(phases).toContain('Report');
    expect(phases).toContain('Done');
  });

  it('rejects an empty query with deep_research.invalid_query', async () => {
    const svc = ix.get(ISessionDeepResearchService);
    await expect(svc.start({ query: '   ' })).rejects.toSatisfy(
      (e: unknown) => isError2(e) && e.code === DeepResearchErrors.codes.INVALID_QUERY,
    );
  });

  it('rejects an over-long query with deep_research.query_too_long', async () => {
    const svc = ix.get(ISessionDeepResearchService);
    await expect(svc.start({ query: 'x'.repeat(4001) })).rejects.toSatisfy(
      (e: unknown) => isError2(e) && e.code === DeepResearchErrors.codes.QUERY_TOO_LONG,
    );
  });

  it('rejects when the main agent is missing', async () => {
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      handleOf: vi.fn(() => undefined),
    } as unknown as IAgentLifecycleService);
    const svc = ix.get(ISessionDeepResearchService);
    await expect(svc.start({ query: 'q' })).rejects.toSatisfy(
      (e: unknown) => isError2(e) && e.code === 'agent.not_found',
    );
  });

  it('rejects when the main agent is already running a turn', async () => {
    mainStubs.status.mockReturnValue({ state: 'running' });
    const svc = ix.get(ISessionDeepResearchService);
    await expect(svc.start({ query: 'q' })).rejects.toSatisfy(
      (e: unknown) => isError2(e) && e.code === 'agent.already_running',
    );
  });

  it('cancel() aborts the in-flight run and skips the handoff reminder', async () => {
    const svc = ix.get(ISessionDeepResearchService);
    const promise = svc.start({ query: 'q' });
    svc.cancel();
    const result = await promise;

    expect(result.status).toBe('cancelled');
    expect(mainStubs.append).not.toHaveBeenCalled();
    // Cancelled runs still emit the final Done progress, tagged with the
    // cancelled status (same behavior as V1).
    expect(mainStubs.publish.mock.calls.some((c) => {
      const message = (c[0] as unknown as { message: string }).message;
      return message.startsWith('Deep research · Done') && message.includes('status=cancelled');
    })).toBe(true);
    // The abort reason must be a UserCancellationError so swarm batches
    // settle with aborted outcomes instead of rejecting (which would
    // surface as an unhandled rejection and crash the host).
    const signals = swarm.run.mock.calls.flatMap(
      (call) => (call[0] as { tasks: readonly { signal?: AbortSignal }[] }).tasks
        .map((task) => task.signal)
        .filter((s): s is AbortSignal => s !== undefined),
    );
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBeInstanceOf(UserCancellationError);
    }
  });

  it('lets a second run abort a previous in-flight run', async () => {
    const svc = ix.get(ISessionDeepResearchService);
    const first = svc.start({ query: 'first' });
    const second = svc.start({ query: 'second' });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe('cancelled');
    expect(secondResult.status).toBe('verified');
  });

  it('maps failed swarm tasks to failed agent outcomes and stays partial', async () => {
    swarm.run.mockImplementation(async ({ tasks }: { readonly tasks: readonly SessionSwarmTask[] }) => {
      return tasks.map((task): SessionSwarmRunResult => {
        if (task.description === 'research-planner') {
          return { task, status: 'failed', error: 'Planner blew up' };
        }
        return { task, status: 'completed', result: makeResearchResult(0).result };
      });
    });
    const svc = ix.get(ISessionDeepResearchService);
    const result: DeepResearchResult = await svc.start({ query: 'q' });

    expect(result.status).toBe('partial');
    expect(result.coverageNotes.some((n) => n.includes('planner failed'))).toBe(true);
  });

  it('reports Failed and rethrows when the swarm run itself rejects', async () => {
    swarm.run.mockRejectedValue(new Error('swarm exploded'));
    const svc = ix.get(ISessionDeepResearchService);
    await expect(svc.start({ query: 'q' })).rejects.toThrow('swarm exploded');
    expect(mainStubs.publish.mock.calls.some((c) =>
      (c[0] as { message: string }).message.startsWith('Deep research · Failed'),
    )).toBe(true);
  });

  it('does not fail the run when the report cannot be written', async () => {
    writeText.mockRejectedValue(new Error('disk full'));
    const svc = ix.get(ISessionDeepResearchService);
    const result = await svc.start({ query: 'q' });
    expect(result.status).toBe('verified');
    expect(result.reportPath).toBeNull();
    expect(result.coverageNotes.some((n) => n.includes('could not be written'))).toBe(true);
  });
});
