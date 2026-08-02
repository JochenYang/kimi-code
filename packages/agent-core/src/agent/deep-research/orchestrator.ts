/**
 * DeepResearchOrchestrator — product contract:
 *
 * Align with Grok Build's *four-phase semantics*
 * (Plan → Research → Verify → cited Report / Partial), not its workflow-engine
 * shape (no Rhai DSL, no agent_budget journal, no /workflows dashboard).
 *
 * Stateless orchestration over a `DeepResearchHost`: the host spawns subagents
 * and writes the report; this class owns phase order, schema validation, caps,
 * and partial aggregation. Fully testable with a fake host.
 */

import { randomUUID } from 'node:crypto';

import { isAbortError } from '../../loop/errors';
import { PlanOutputSchema, ResearchOutputSchema, VerifyOutputSchema, tryParseJson } from './schemas';
import { buildPlanPrompt, buildResearchPrompt, buildVerifyPrompt, buildSynthesisPrompt } from './prompts';
import { buildFullReport, buildChatReport } from './report-builder';
import { extractReportBody, validateCitations, isValidClaim } from './utils';
import type {
  DeepResearchInput,
  DeepResearchResult,
  DeepResearchHost,
  DeepResearchAgentOutcome,
  DeepResearchPhase,
  DeepResearchStatus,
  CandidateClaim,
  VerifiedClaim,
} from './types';
import {
  DEEP_RESEARCH_DEFAULT_BREADTH,
  DEEP_RESEARCH_MAX_BREADTH,
  DEEP_RESEARCH_MIN_BREADTH,
  DEEP_RESEARCH_CANDIDATE_CAP,
  DEEP_RESEARCH_MAX_VERIFIERS,
} from './types';

export class DeepResearchOrchestrator {
  private readonly runId: string;
  private readonly host: DeepResearchHost;
  private readonly originalQuery: string;
  private readonly breadth: number;
  private readonly coverageNotes: string[] = [];
  private partial = false;

  constructor(input: DeepResearchInput, host: DeepResearchHost) {
    this.runId = randomUUID().slice(0, 8);
    this.host = host;
    this.originalQuery = input.query;
    this.breadth = clampBreadth(input.breadth);
  }

  /** Run the full deep-research workflow. */
  async run(signal: AbortSignal): Promise<DeepResearchResult> {
    // ── Phase 1: Plan ──────────────────────────────────────────────────
    try {
      signal.throwIfAborted();
      await this.phase('Plan', 'Decompose query into independent questions');
      const questions = await this.planPhase(signal);
      signal.throwIfAborted();

      if (questions.length === 0) {
        this.partial = true;
        this.coverageNotes.push('The planner returned no usable questions.');
        return this.buildEmptyResult('partial', 'No research questions could be generated.');
      }

      // ── Phase 2: Research ────────────────────────────────────────────
      await this.phase(
        'Research',
        `Gather structured claims in parallel (${String(questions.length)} question(s))`,
      );
      const candidates = await this.researchPhase(questions, signal);
      signal.throwIfAborted();

      if (candidates.length === 0) {
        this.partial = true;
        this.coverageNotes.push('No factual claim had both traceable evidence and a precise source locator.');
        return this.buildEmptyResult('partial', 'No supported factual answer could be produced.');
      }

      // ── Phase 3: Verify ──────────────────────────────────────────────
      await this.phase('Verify', 'Cross-check every candidate claim');
      const verified = await this.verifyPhase(candidates, signal);
      signal.throwIfAborted();

      if (verified.length === 0) {
        this.partial = true;
        this.coverageNotes.push('No candidate claim survived independent source verification.');
        return this.buildEmptyResult('partial', 'None of the candidate claims survived independent source verification.');
      }

      // ── Phase 4: Report ──────────────────────────────────────────────
      await this.phase('Report', 'Synthesize verified claims into cited prose');
      return await this.reportPhase(verified, questions, signal);

    } catch (error) {
      if (isAbortError(error)) {
        return this.buildEmptyResult('cancelled', 'The research was cancelled.');
      }
      throw error;
    }
  }

  // ── Phase 1: Plan ────────────────────────────────────────────────────────

  private async planPhase(signal: AbortSignal): Promise<string[]> {
    const result = await this.host.runAgent({
      profileName: 'explore',
      prompt: buildPlanPrompt(this.originalQuery, this.breadth),
      description: 'research-planner',
      label: 'research-planner',
      phase: 'Plan',
    }, signal);

    if (!result.success) {
      this.partial = true;
      this.coverageNotes.push('The planner failed; researching the original query as one question.');
      return [this.originalQuery];
    }

    const parsed = tryParseJson(result.output, PlanOutputSchema);
    if (!parsed.ok) {
      this.partial = true;
      this.coverageNotes.push(
        `The planner returned unparseable output; researching the original query as one question. (${parsed.error})`,
      );
      return [this.originalQuery];
    }

    const planned = parsed.data.questions
      .map((q) => q.trim())
      .filter((q) => q.length > 0)
      .slice(0, this.breadth);
    if (planned.length === 0) {
      this.partial = true;
      this.coverageNotes.push('The planner returned zero questions; researching the original query as one question.');
      return [this.originalQuery];
    }

    await this.phase(
      'Plan',
      `Planned ${String(planned.length)} question(s); starting research…`,
    );
    return planned;
  }

  // ── Phase 2: Research ────────────────────────────────────────────────────

  private async researchPhase(questions: string[], signal: AbortSignal): Promise<CandidateClaim[]> {
    const calls = questions.map((q, i) => ({
      profileName: 'explore' as const,
      prompt: buildResearchPrompt(q),
      description: `researcher-${i}`,
      label: `researcher-${i}`,
      phase: 'Research' as const,
    }));

    const results = await this.host.runParallel(calls, signal);

    const candidates: CandidateClaim[] = [];
    let successfulQuestions = 0;
    let droppedClaims = 0;

    for (let i = 0; i < results.length; i++) {
      const r: DeepResearchAgentOutcome | undefined = results[i] as DeepResearchAgentOutcome | undefined;
      if (r === undefined || !r.success) {
        this.partial = true;
        this.coverageNotes.push(`Question ${i + 1} failed or returned unusable structured research: ${questions[i]}`);
        continue;
      }

      const parsed = tryParseJson(r.output, ResearchOutputSchema);
      if (!parsed.ok) {
        this.partial = true;
        this.coverageNotes.push(`Question ${i + 1} returned unparseable output: ${questions[i]}`);
        continue;
      }

      successfulQuestions++;

      const research = parsed.data;
      for (const uncertainty of research.uncertainties) {
        if (uncertainty.trim().length > 0) {
          this.partial = true;
          this.coverageNotes.push(`Question ${i + 1} uncertainty: ${uncertainty}`);
        }
      }

      for (const claim of research.claims) {
        if (!isValidClaim(claim)) {
          droppedClaims++;
          continue;
        }
        if (candidates.length >= DEEP_RESEARCH_CANDIDATE_CAP) {
          droppedClaims++;
          continue;
        }
        candidates.push({
          ...claim,
          id: `claim-${candidates.length}`,
          question_index: i,
        });
      }
    }

    if (droppedClaims > 0) {
      this.partial = true;
      this.coverageNotes.push(`${droppedClaims} malformed or over-cap candidate claim(s) were excluded before verification.`);
    }

    if (successfulQuestions < questions.length) {
      this.partial = true;
    }

    return candidates;
  }

  // ── Phase 3: Verify ──────────────────────────────────────────────────────

  private async verifyPhase(
    candidates: CandidateClaim[],
    signal: AbortSignal,
  ): Promise<VerifiedClaim[]> {
    const verifierCount = Math.min(DEEP_RESEARCH_MAX_VERIFIERS, candidates.length);
    if (verifierCount === 0) return [];

    // Distribute claims across verifier shards
    const shards: CandidateClaim[][] = Array.from({ length: verifierCount }, () => []);
    for (let i = 0; i < candidates.length; i++) {
      const c: CandidateClaim | undefined = candidates[i] as CandidateClaim | undefined;
      if (c !== undefined) {
        shards[i % verifierCount]!.push(c);
      }
    }
    const expectedIds = shards.map((s) => s.map((c) => c.id));

    const verifyCalls = shards.map((shard, i) => ({
      profileName: 'explore' as const,
      prompt: buildVerifyPrompt(JSON.stringify(shard, null, 2)),
      description: `evidence-verifier-${i}`,
      label: `evidence-verifier-${i}`,
      phase: 'Verify' as const,
    }));

    const results = await this.host.runParallel(verifyCalls, signal);

    // Determine which shards are valid
    const shardValid: boolean[] = [];
    for (let i = 0; i < verifierCount; i++) {
      const r: DeepResearchAgentOutcome | undefined = results[i] as DeepResearchAgentOutcome | undefined;
      let valid = true;

      if (r === undefined || !r.success) {
        valid = false;
      } else {
        const parsed = tryParseJson(r.output, VerifyOutputSchema);
        if (!parsed.ok) {
          valid = false;
        } else {
          const verdicts = parsed.data.verdicts;
          // Check exact claim_id matching
          const verdictIds = new Set(verdicts.map((v) => v.claim_id));
          const expected = new Set(expectedIds[i] ?? []);

          if (verdictIds.size !== expected.size || ![...verdictIds].every((id) => expected.has(id))) {
            valid = false;
          }
        }
      }

      if (!valid) {
        this.partial = true;
        this.coverageNotes.push(`Verifier shard ${i + 1} failed exact claim-ID validation; all assigned claims were excluded.`);
      }
      shardValid.push(valid);
    }

    // Assemble verified claims
    const verified: VerifiedClaim[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c: CandidateClaim | undefined = candidates[i] as CandidateClaim | undefined;
      if (c === undefined) continue;
      const shard = i % verifierCount;

      if (!shardValid[shard]!) {
        this.partial = true;
        this.coverageNotes.push(`Claim ${c.id} was excluded because its verifier shard failed validation.`);
        continue;
      }

      const r: DeepResearchAgentOutcome | undefined = results[shard] as DeepResearchAgentOutcome | undefined;
      if (r === undefined || !r.success) continue;

      const parsed = tryParseJson(r.output, VerifyOutputSchema);
      if (!parsed.ok) continue;

      const verdict = parsed.data.verdicts.find((v) => v.claim_id === c.id);
      if (!verdict) {
        this.partial = true;
        this.coverageNotes.push(`Claim ${c.id} was excluded because no verdict was returned.`);
        continue;
      }

      if (
        verdict.supported
        && typeof verdict.evidence === 'string' && verdict.evidence.trim().length > 0
        && typeof verdict.source_title === 'string' && verdict.source_title.trim().length > 0
        && typeof verdict.source_locator === 'string' && verdict.source_locator.trim().length > 0
      ) {
        verified.push({
          id: c.id,
          claim: c.claim,
          original_evidence: c.evidence,
          original_source_title: c.source_title,
          original_source_locator: c.source_locator,
          verifier_evidence: verdict.evidence,
          verifier_source_title: verdict.source_title,
          verifier_source_locator: verdict.source_locator,
          verifier_note: verdict.reason,
        });
      } else {
        this.partial = true;
        this.coverageNotes.push(`Claim ${c.id} was excluded by verification: ${verdict.reason}`);
      }
    }

    return verified;
  }

  // ── Phase 4: Report ──────────────────────────────────────────────────────

  private async reportPhase(
    verified: VerifiedClaim[],
    questions: readonly string[],
    signal: AbortSignal,
  ): Promise<DeepResearchResult> {
    const status: DeepResearchStatus = this.partial ? 'partial' : 'verified';

    // Build citation packet
    const citationPacket = verified.map((f, i) => ({
      citation: `S${i + 1}`,
      claim: f.claim,
      evidence: f.original_evidence,
      source_title: f.original_source_title,
      confidence_note: f.verifier_note,
    }));

    // Build deterministic fallback body
    const fallbackBody = '## Findings\n' + verified.map((f, i) => `- ${f.claim} [S${i + 1}]`).join('\n');

    let body = fallbackBody;

    // Try LLM synthesis. Abort must rethrow so the outer catch can mark cancelled;
    // only non-abort synthesis failures fall back to the deterministic list.
    try {
      signal.throwIfAborted();
      const synthesisPrompt = buildSynthesisPrompt(this.originalQuery, JSON.stringify(citationPacket, null, 2));

      const synthesisResult = await this.host.runAgent({
        profileName: 'explore',
        prompt: synthesisPrompt,
        description: 'report-synthesizer',
        label: 'report-synthesizer',
        phase: 'Report',
      }, signal);

      if (synthesisResult.success && typeof synthesisResult.output === 'string') {
        const draft = extractReportBody(synthesisResult.output);
        if (draft !== null && draft.length > 0) {
          const valid = validateCitations(draft, verified.length);
          if (valid) {
            body = draft;
          } else {
            this.coverageNotes.push('The synthesized report body failed citation validation; the deterministic finding list is shown instead.');
          }
        } else {
          this.coverageNotes.push('Report synthesis returned no usable body; the deterministic finding list is shown instead.');
        }
      } else {
        this.coverageNotes.push('Report synthesis returned no usable body; the deterministic finding list is shown instead.');
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.coverageNotes.push('Report synthesis failed; the deterministic finding list is shown instead.');
    }

    // Build final reports
    const fullReport = buildFullReport({
      status,
      body,
      verifiedClaims: verified,
      coverageNotes: this.coverageNotes,
    });

    // Write to scratch
    let reportPath: string | null = null;
    try {
      signal.throwIfAborted();
      reportPath = await this.host.writeReport(this.runId, fullReport);
    } catch {
      // Non-fatal: report is still available in memory
      this.coverageNotes.push('The full report could not be written to disk.');
    }

    const chatReport = buildChatReport(body, this.partial);

    return {
      status,
      report: fullReport,
      chatReport,
      reportPath,
      verifiedClaimIds: verified.map((f) => f.id),
      coverageNotes: this.coverageNotes,
      questions: [...questions],
      runId: this.runId,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private buildEmptyResult(status: DeepResearchStatus, fallbackMessage: string): DeepResearchResult {
    const report = `# Research result\n\n**Status: ${capitalize(status)}**\n\n${fallbackMessage}\n\n## Coverage and uncertainty\n${this.coverageNotes.map((n) => `- ${n}`).join('\n')}\n`;

    return {
      status,
      report,
      chatReport: `**Status: ${capitalize(status)}**\n\n${fallbackMessage}`,
      reportPath: null,
      verifiedClaimIds: [],
      coverageNotes: this.coverageNotes,
      questions: [],
      runId: this.runId,
    };
  }

  private async phase(phase: DeepResearchPhase, detail: string): Promise<void> {
    this.host.onProgress?.({ phase, detail });
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────────

function clampBreadth(breadth?: number): number {
  if (breadth === undefined) return DEEP_RESEARCH_DEFAULT_BREADTH;
  return Math.max(DEEP_RESEARCH_MIN_BREADTH, Math.min(DEEP_RESEARCH_MAX_BREADTH, breadth));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}