/**
 * Deep research — four-phase semantics (Plan → Research → Verify → Report).
 * Align product behavior with that pipeline; do not grow a general workflow engine here.
 */
export { DeepResearchOrchestrator } from './orchestrator';
export { createDeepResearchHost } from './host-adapter';
export type {
  DeepResearchInput,
  DeepResearchResult,
  DeepResearchHost,
  DeepResearchProgress,
  DeepResearchPhase,
  DeepResearchStatus,
  DeepResearchAgentCall,
  DeepResearchAgentOutcome,
  DeepResearchClaim,
  CandidateClaim,
  VerifiedClaim,
  DeepResearchVerdict,
} from './types';
export {
  DEEP_RESEARCH_DEFAULT_BREADTH,
  DEEP_RESEARCH_MIN_BREADTH,
  DEEP_RESEARCH_MAX_BREADTH,
  DEEP_RESEARCH_MAX_CLAIMS_PER_QUESTION,
  DEEP_RESEARCH_CANDIDATE_CAP,
  DEEP_RESEARCH_MAX_QUERY_LENGTH,
} from './types';
export {
  PlanOutputSchema,
  ResearchOutputSchema,
  VerifyOutputSchema,
  ClaimSchema,
  VerdictSchema,
  tryParseJson,
} from './schemas';
export { buildPlanPrompt, buildResearchPrompt, buildVerifyPrompt, buildSynthesisPrompt } from './prompts';
export { buildFullReport, buildChatReport } from './report-builder';
export { formatDeepResearchHandoff, DEEP_RESEARCH_HANDOFF_SUMMARY_CHARS } from './handoff';
export { validateCitations, extractReportBody, isValidClaim } from './utils';
