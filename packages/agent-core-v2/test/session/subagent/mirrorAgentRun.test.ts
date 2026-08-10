/**
 * `subagent` domain — `mirrorAgentRun` caller-side mirroring tests.
 *
 * Verifies the terminal signals a requester publishes for a driven agent
 * run: `subagent.completed` on success, `subagent.failed` on ordinary
 * errors, and — critically — `subagent.failed` with the cancellation text
 * on abort, so the UI can settle the subagent card instead of spinning
 * forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { UserCancellationError, abortError } from '#/_base/utils/abort';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService, type AgentRunHandle } from '#/session/subagent/subagent';

function makeRequester(events: unknown[]): IAgentScopeHandle {
  return {
    _serviceBrand: undefined,
    id: 'main',
    accessor: {
      get: (id: unknown) => {
        if (id === IEventBus) return { publish: (event: unknown) => events.push(event) };
        if (id === ISessionSubagentService) {
          return { hooks: { onWillStartAgentTask: { run: async () => undefined } }, notifyAgentTaskStopped: vi.fn() };
        }
        if (id === IAgentLifecycleService) return { get: () => undefined };
        return undefined;
      },
    },
  } as unknown as IAgentScopeHandle;
}

function makeRunHandle(result?: { readonly summary: string; readonly usage?: unknown }, error?: unknown): AgentRunHandle {
  return {
    agentId: 'child-1',
    turn: { id: 1 } as never,
    completion: error === undefined
      ? Promise.resolve({ summary: result?.summary ?? '', usage: result?.usage as never })
      : Promise.reject(error),
  };
}

describe('mirrorAgentRun', () => {
  let disposables: DisposableStore;
  let events: unknown[];

  beforeEach(() => {
    disposables = new DisposableStore();
    events = [];
  });
  afterEach(() => disposables.dispose());

  it('publishes subagent.completed on success', async () => {
    const requester = makeRequester(events);
    const run = makeRunHandle({ summary: 'done', usage: undefined });
    const result = await mirrorAgentRun(requester, run, {
      profileName: 'explore',
      prompt: 'hello',
      signal: new AbortController().signal,
    });

    expect(result.summary).toBe('done');
    expect(events).toContainEqual({ type: 'subagent.started', subagentId: 'child-1' });
    expect(events).toContainEqual({
      type: 'subagent.completed',
      subagentId: 'child-1',
      resultSummary: 'done',
      usage: undefined,
      contextTokens: undefined,
    });
  });

  it('publishes subagent.failed on an ordinary error and rethrows', async () => {
    const requester = makeRequester(events);
    const run = makeRunHandle(undefined, new Error('boom'));
    await expect(
      mirrorAgentRun(requester, run, {
        profileName: 'explore',
        prompt: 'hello',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('boom');

    expect(events).toContainEqual({
      type: 'subagent.failed',
      subagentId: 'child-1',
      error: 'boom',
    });
  });

  it('publishes subagent.failed with the cancellation text on user abort', async () => {
    const requester = makeRequester(events);
    const signal = new AbortController().signal;
    const run = makeRunHandle(undefined, new UserCancellationError());
    await expect(
      mirrorAgentRun(requester, run, {
        profileName: 'explore',
        prompt: 'hello',
        signal,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof UserCancellationError);

    // The UI maps 'Aborted by the user' to the cancelled card state.
    expect(events).toContainEqual({
      type: 'subagent.failed',
      subagentId: 'child-1',
      error: 'Aborted by the user',
    });
  });

  it('publishes subagent.failed on a non-user abort error', async () => {
    const requester = makeRequester(events);
    const run = makeRunHandle(undefined, abortError('Agent removed'));
    await expect(
      mirrorAgentRun(requester, run, {
        profileName: 'explore',
        prompt: 'hello',
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((e: unknown) => (e as Error).name === 'AbortError');

    expect(events).toContainEqual({
      type: 'subagent.failed',
      subagentId: 'child-1',
      error: 'Agent removed',
    });
  });
});
