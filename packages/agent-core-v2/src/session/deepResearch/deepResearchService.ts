import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { userCancellationReason } from '#/_base/utils/abort';
import { WarningIssued } from '#/agent/profile/profileOps';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionSwarmService,
  type SessionSwarmRunResult,
} from '#/session/swarm/sessionSwarm';

import { ISessionDeepResearchService, type StartDeepResearchInput } from './deepResearch';
import { DeepResearchErrors } from './errors';
import { formatDeepResearchHandoff } from './handoff';
import { DeepResearchOrchestrator } from './orchestrator';
import { DEEP_RESEARCH_MAX_QUERY_LENGTH } from './types';
import type {
  DeepResearchAgentCall,
  DeepResearchAgentOutcome,
  DeepResearchHost,
  DeepResearchPhase,
  DeepResearchResult,
} from './types';

export class SessionDeepResearchService implements ISessionDeepResearchService {
  declare readonly _serviceBrand: undefined;

  private current: AbortController | undefined;

  constructor(
    @ISessionSwarmService private readonly swarm: ISessionSwarmService,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async start(input: StartDeepResearchInput): Promise<DeepResearchResult> {
    const query = input.query.trim();
    if (query.length === 0) {
      throw new Error2(
        DeepResearchErrors.codes.INVALID_QUERY,
        'Deep research query cannot be empty',
      );
    }
    if (query.length > DEEP_RESEARCH_MAX_QUERY_LENGTH) {
      throw new Error2(
        DeepResearchErrors.codes.QUERY_TOO_LONG,
        `Deep research query is too long (max ${DEEP_RESEARCH_MAX_QUERY_LENGTH} characters)`,
      );
    }
    const main = this.lifecycle.handleOf(MAIN_AGENT_ID);
    if (main === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Main agent "${MAIN_AGENT_ID}" does not exist`, {
        details: { agentId: MAIN_AGENT_ID },
      });
    }
    if (main.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        'Cannot start deep research while another turn is active',
      );
    }

    const controller = new AbortController();
    this.current?.abort(userCancellationReason());
    this.current = controller;

    const runScopeId = `deep-research-${randomUUID().slice(0, 8)}`;
    const reportProgress = (progress: { phase: string; detail: string }): void => {
      void main.accessor
        .get(IEventDispatcher)
        .dispatch(
          new WarningIssued({
            agentId: MAIN_AGENT_ID,
            code: 'deep-research-progress',
            message: `Deep research · ${progress.phase}: ${progress.detail}`,
          }),
        );
      try {
        input.onProgress?.({ phase: progress.phase as DeepResearchPhase, detail: progress.detail });
      } catch {}
    };

    const host: DeepResearchHost = {
      runAgent: (call, signal) => this.runAgent(runScopeId, call, signal),
      runParallel: (calls, signal) => this.runParallel(runScopeId, calls, signal),
      writeReport: (runId, markdown) => this.writeReport(main, runId, markdown),
      onProgress: reportProgress,
    };
    const orchestrator = new DeepResearchOrchestrator({ query, breadth: input.breadth }, host);
    try {
      // Phase progress (incl. the initial Plan) is emitted by the orchestrator
      // itself through host.onProgress; do not duplicate it here.
      const result = await orchestrator.run(controller.signal);
      reportProgress({
        phase: 'Done',
        detail: `status=${result.status}; report=${result.reportPath ?? '(in-memory)'}`,
      });
      // Handoff into main context so the next user turn can continue from
      // the research (summary + report path). Cancelled runs skip this.
      // Does not start a turn — only appends for the following prompt.
      if (result.status !== 'cancelled') {
        main.accessor.get(IAgentContextMemoryService).append({
          role: 'user',
          content: [{ type: 'text', text: wrapSystemReminder(formatDeepResearchHandoff(result, query)) }],
          toolCalls: [],
          origin: { kind: 'injection', variant: 'deep_research_handoff' },
        });
      }
      return result;
    } catch (error) {
      reportProgress({
        phase: 'Failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (this.current === controller) {
        this.current = undefined;
      }
    }
  }

  cancel(): void {
    // User cancellation: give the abort a UserCancellationError reason so
    // in-flight swarm batches settle with aborted outcomes instead of
    // rejecting (a bare abort would reject and could crash the host).
    this.current?.abort(userCancellationReason());
  }

  // ── Host adapter ──────────────────────────────────────────────────────────

  private async runAgent(
    runScopeId: string,
    call: DeepResearchAgentCall,
    signal: AbortSignal,
  ): Promise<DeepResearchAgentOutcome> {
    const results = await this.runParallel(runScopeId, [call], signal);
    return results[0] ?? { success: false, output: '', error: 'No agent run result' };
  }

  private async runParallel(
    runScopeId: string,
    calls: readonly DeepResearchAgentCall[],
    signal: AbortSignal,
  ): Promise<readonly DeepResearchAgentOutcome[]> {
    const results = await this.swarm.run<undefined>({
      callerAgentId: MAIN_AGENT_ID,
      tasks: calls.map((call, i) => ({
        kind: 'spawn',
        data: undefined,
        profileName: call.profileName,
        plan: {
          profileName: call.profileName,
          model: '',
          fork: false,
        },
        parentToolCallId: `${runScopeId}:${call.label}`,
        prompt: call.prompt,
        description: call.description,
        swarmIndex: i,
        runInBackground: false,
        signal,
      })),
    });
    return results.map((r) => toOutcome(r));
  }

  private async writeReport(
    main: IAgentScopeHandle,
    runId: string,
    markdown: string,
  ): Promise<string> {
    const reportDir = join(
      this.bootstrap.homeDir,
      main.accessor.get(IAgentScopeContext).scope('deep-research'),
      runId,
    );
    const reportPath = join(reportDir, 'report.md');
    await this.hostFs.mkdir(reportDir, { recursive: true });
    await this.hostFs.writeText(reportPath, markdown);
    return reportPath;
  }
}

function toOutcome(result: SessionSwarmRunResult<undefined>): DeepResearchAgentOutcome {
  if (result.status === 'completed') {
    return { success: true, output: result.result ?? '', agentId: result.agentId };
  }
  return { success: false, output: '', error: result.error, agentId: result.agentId };
}

registerScopedService(
  LifecycleScope.Session,
  ISessionDeepResearchService,
  SessionDeepResearchService,
  ScopeActivation.OnScopeCreated,
  'deepResearch',
);
