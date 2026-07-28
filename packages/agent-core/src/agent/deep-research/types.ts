/** Deep-research workflow types — pure data, no runtime deps. */

export const DEEP_RESEARCH_DEFAULT_BREADTH = 4;
export const DEEP_RESEARCH_MIN_BREADTH = 2;
export const DEEP_RESEARCH_MAX_BREADTH = 6;
export const DEEP_RESEARCH_MAX_CLAIMS_PER_QUESTION = 6;
export const DEEP_RESEARCH_MAX_UNCERTAINTIES = 6;
export const DEEP_RESEARCH_CANDIDATE_CAP = 24;
export const DEEP_RESEARCH_MAX_QUERY_LENGTH = 4000;
export const DEEP_RESEARCH_MAX_VERIFIERS = 2;

export type DeepResearchStatus = 'verified' | 'partial' | 'cancelled';

export type DeepResearchSourceType = 'primary' | 'secondary' | 'repository' | 'other';
export type DeepResearchConfidence = 'high' | 'medium' | 'low';

export interface DeepResearchClaim {
  readonly claim: string;
  readonly evidence: string;
  readonly source_title: string;
  readonly source_locator: string;
  readonly source_type: DeepResearchSourceType;
  readonly confidence: DeepResearchConfidence;
}

export interface CandidateClaim extends DeepResearchClaim {
  readonly id: string;
  readonly question_index: number;
}

export interface VerifiedClaim {
  readonly id: string;
  readonly claim: string;
  readonly original_evidence: string;
  readonly original_source_title: string;
  readonly original_source_locator: string;
  readonly verifier_evidence: string;
  readonly verifier_source_title: string;
  readonly verifier_source_locator: string;
  readonly verifier_note: string;
}

export interface DeepResearchVerdict {
  readonly claim_id: string;
  readonly supported: boolean;
  readonly reason: string;
  readonly evidence?: string;
  readonly source_title?: string;
  readonly source_locator?: string;
}

export interface DeepResearchInput {
  readonly query: string;
  /** Independent research questions; defaults to 4, clamped to 2–6. */
  readonly breadth?: number;
}

export interface DeepResearchResult {
  readonly status: DeepResearchStatus;
  /** Full markdown report written to scratch (includes Sources + Coverage). */
  readonly report: string;
  /** Shorter body suitable for chat (may omit Sources). */
  readonly chatReport: string;
  readonly reportPath: string | null;
  readonly verifiedClaimIds: readonly string[];
  readonly coverageNotes: readonly string[];
  readonly questions: readonly string[];
  readonly runId: string;
}

export type DeepResearchPhase = 'Plan' | 'Research' | 'Verify' | 'Report';

export interface DeepResearchProgress {
  readonly phase: DeepResearchPhase;
  readonly detail: string;
}

export interface DeepResearchAgentCall {
  readonly profileName: string;
  readonly prompt: string;
  readonly description: string;
  readonly label: string;
  readonly phase: DeepResearchPhase;
}

export interface DeepResearchAgentOutcome {
  readonly success: boolean;
  readonly output: string;
  readonly error?: string;
  readonly agentId?: string;
}

/**
 * Host capabilities the orchestrator needs. Implemented by Agent via
 * SessionSubagentHost; tests inject fakes.
 */
export interface DeepResearchHost {
  runAgent(call: DeepResearchAgentCall, signal: AbortSignal): Promise<DeepResearchAgentOutcome>;
  runParallel(
    calls: readonly DeepResearchAgentCall[],
    signal: AbortSignal,
  ): Promise<readonly DeepResearchAgentOutcome[]>;
  writeReport(runId: string, markdown: string): Promise<string>;
  onProgress?(progress: DeepResearchProgress): void;
}
