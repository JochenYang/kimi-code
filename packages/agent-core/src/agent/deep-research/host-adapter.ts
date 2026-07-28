/**
 * DeepResearchHost adapter — maps SessionSubagentHost + kaos to the
 * orchestrator's DeepResearchHost interface.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isAbortError } from '../../loop/errors';
import type { DeepResearchHost, DeepResearchAgentCall, DeepResearchAgentOutcome, DeepResearchProgress } from './types';
import type { SessionSubagentHost, SubagentHandle } from '../../session/subagent-host';

/** Deep-research scratch directory name inside agent homedir. */
const DEEP_RESEARCH_DIR = 'deep-research';

/**
 * Build a DeepResearchHost from the agent's subagent host and homedir.
 *
 * Each subagent gets its **own** synthetic parentToolCallId (`${runScope}:${label}`)
 * so the TUI does not collapse Plan/Research/Verify onto one Completed card and
 * drop the handoff. Progress should be delivered via agent events as well as
 * `onProgress` — in-process RPC JSON-clones payloads and strips functions.
 */
export function createDeepResearchHost(
  subagentHost: SessionSubagentHost,
  homedir: string,
  runScopeId: string,
  onProgress?: (progress: DeepResearchProgress) => void,
): DeepResearchHost {
  const parentIdFor = (call: DeepResearchAgentCall): string =>
    `${runScopeId}:${call.label}`;

  return {
    onProgress,

    runAgent: async (call: DeepResearchAgentCall, signal: AbortSignal): Promise<DeepResearchAgentOutcome> => {
      try {
        const handle: SubagentHandle = await subagentHost.spawn({
          parentToolCallId: parentIdFor(call),
          prompt: call.prompt,
          description: call.description,
          profileName: call.profileName,
          runInBackground: false,
          // Keep structured JSON/report text intact — do not expand short answers.
          skipSummaryContinuation: true,
          signal,
        });
        const completion = await handle.completion;
        return {
          success: true,
          output: completion.result,
          agentId: handle.agentId,
        };
      } catch (error) {
        // Propagate user/cancel aborts so the orchestrator can mark cancelled.
        if (isAbortError(error) || signal.aborted) throw error;
        return {
          success: false,
          output: '',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    runParallel: async (
      calls: readonly DeepResearchAgentCall[],
      signal: AbortSignal,
    ): Promise<readonly DeepResearchAgentOutcome[]> => {
      // Prefer true parallelism via runQueued. Fall back to sequential runAgent
      // only when the batch API rejects the task list (should not happen for
      // deep-research sizes).
      const tasks = calls.map((call, index) => ({
        kind: 'spawn' as const,
        data: call,
        profileName: call.profileName,
        parentToolCallId: parentIdFor(call),
        prompt: call.prompt,
        description: call.description,
        swarmIndex: index,
        runInBackground: false,
        skipSummaryContinuation: true,
        signal,
      }));

      try {
        const results = await subagentHost.runQueued(tasks);
        if (signal.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
        }
        return results.map((r) => ({
          success: r.status === 'completed',
          output: r.result ?? '',
          error: r.error,
          agentId: r.agentId,
        }));
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error;
        // Sequential fallback so one batch failure does not zero the whole phase.
        const outcomes: DeepResearchAgentOutcome[] = [];
        for (const call of calls) {
          signal.throwIfAborted();
          outcomes.push(
            await (async () => {
              try {
                const handle = await subagentHost.spawn({
                  parentToolCallId: parentIdFor(call),
                  prompt: call.prompt,
                  description: call.description,
                  profileName: call.profileName,
                  runInBackground: false,
                  skipSummaryContinuation: true,
                  signal,
                });
                const completion = await handle.completion;
                return {
                  success: true,
                  output: completion.result,
                  agentId: handle.agentId,
                };
              } catch (inner) {
                if (isAbortError(inner) || signal.aborted) throw inner;
                return {
                  success: false,
                  output: '',
                  error: inner instanceof Error ? inner.message : String(inner),
                };
              }
            })(),
          );
        }
        return outcomes;
      }
    },

    writeReport: async (runId: string, markdown: string): Promise<string> => {
      const dir = join(homedir, DEEP_RESEARCH_DIR, runId);
      await mkdir(dir, { recursive: true });
      const path = join(dir, 'report.md');
      await writeFile(path, markdown, 'utf-8');
      return path;
    },
  };
}