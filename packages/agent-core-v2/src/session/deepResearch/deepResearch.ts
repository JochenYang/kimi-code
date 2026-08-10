/**
 * `deepResearch` domain — session-scoped deep-research service contract.
 *
 * Runs the four-phase deep-research pipeline (Plan → Research → Verify →
 * cited Report) on behalf of the session's main agent: subagents are spawned
 * under the main agent via `ISessionSwarmService`, and the full report is
 * written under the main agent's scope directory. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { DeepResearchProgress, DeepResearchResult } from './types';

export interface StartDeepResearchInput {
  readonly query: string;
  /** Independent research questions; defaults to 4, clamped to 2–6. */
  readonly breadth?: number;
  readonly onProgress?: (progress: DeepResearchProgress) => void;
}

export interface ISessionDeepResearchService {
  readonly _serviceBrand: undefined;

  start(input: StartDeepResearchInput): Promise<DeepResearchResult>;
  /** Abort the in-flight deep-research run, if any. */
  cancel(): void;
}

export const ISessionDeepResearchService: ServiceIdentifier<ISessionDeepResearchService> =
  createDecorator<ISessionDeepResearchService>('sessionDeepResearchService');
