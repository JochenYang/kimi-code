/**
 * Main-agent context handoff after a deep-research run.
 *
 * The pipeline does not use a main turn, so the report is invisible to the
 * next user message unless we inject a short summary + report path. Full
 * report body stays on disk; the model Reads the path when it needs detail.
 */

import type { DeepResearchResult } from './types';

/** Soft cap so a large chatReport does not dominate the main context. */
export const DEEP_RESEARCH_HANDOFF_SUMMARY_CHARS = 4_000;

/**
 * Build the text injected into the main agent context after a successful
 * (verified / partial) deep-research run. Not used for cancelled runs.
 */
export function formatDeepResearchHandoff(result: DeepResearchResult, query: string): string {
  const statusLabel = result.status;
  const summary = truncateForHandoff(result.chatReport.trim());
  const lines: string[] = [
    'Deep research finished and is available for follow-up work in this session.',
    `Query: ${query.trim()}`,
    `Status: ${statusLabel}`,
  ];

  if (summary.length > 0) {
    lines.push('', 'Summary:', summary);
  } else {
    lines.push('', 'Summary: (empty — see full report if a path is provided below.)');
  }

  if (result.reportPath !== null && result.reportPath.length > 0) {
    lines.push(
      '',
      `Full report path: ${result.reportPath}`,
      'When you need citations, sources, coverage notes, or more detail, use the Read tool on that path.',
    );
  }

  if (result.coverageNotes.length > 0) {
    lines.push(
      '',
      `${String(result.coverageNotes.length)} coverage note(s) recorded — see the full report for gaps.`,
    );
  }

  return lines.join('\n');
}

function truncateForHandoff(text: string): string {
  if (text.length <= DEEP_RESEARCH_HANDOFF_SUMMARY_CHARS) return text;
  return `${text.slice(0, DEEP_RESEARCH_HANDOFF_SUMMARY_CHARS)}\n\n…(truncated; see full report path for the rest)`;
}
