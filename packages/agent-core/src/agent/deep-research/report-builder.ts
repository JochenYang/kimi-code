/**
 * Build the final markdown report from verified claims and coverage notes.
 */

import { deduplicateSources } from './utils';
import type { VerifiedClaim, DeepResearchStatus } from './types';

export interface ReportInput {
  readonly status: DeepResearchStatus;
  readonly body: string;
  readonly verifiedClaims: readonly VerifiedClaim[];
  readonly coverageNotes: readonly string[];
}

/**
 * Build a full markdown report with Sources and Coverage sections.
 * This is written to the scratch file.
 */
export function buildFullReport(input: ReportInput): string {
  const statusLabel = input.status === 'verified' ? 'Verified' : 'Partial';

  let report = `# Research result\n\n**Status: ${statusLabel}**\n\n`;
  report += input.body;
  report += '\n';

  // ── Sources section ──────────────────────────────────────────────────
  report += '\n## Sources\n';
  const deduplicated = deduplicateSources(
    input.verifiedClaims.map((f, i) => ({
      citations: [`S${String(i + 1)}`],
      title: f.original_source_title,
      locator: f.original_source_locator,
      v_title: f.verifier_source_title,
      v_locator: f.verifier_source_locator,
    })),
  );

  for (const row of deduplicated) {
    const ids = row.citations.map((c) => `[${c}]`).join(' ');
    report += `- ${ids} ${row.title} — ${row.locator}`;
    if (row.v_locator !== row.locator || row.v_title !== row.title) {
      report += ` (independently checked against ${row.v_title} — ${row.v_locator})`;
    }
    report += '\n';
  }

  // ── Coverage and uncertainty ─────────────────────────────────────────
  report += '\n## Coverage and uncertainty\n';
  if (input.coverageNotes.length === 0) {
    report += '- All planned questions returned usable structured research, and every retained claim passed its assigned verifier shard.\n';
  } else {
    for (const note of input.coverageNotes) {
      report += `- ${note}\n`;
    }
  }

  return report;
}

/**
 * Build a shorter chat report body for inline display.
 * For partial results, prefixes with a status warning.
 */
export function buildChatReport(body: string, partial: boolean): string {
  if (partial) {
    return `**Status: Partial** — see the full report for coverage gaps.\n\n${body}`;
  }
  return body;
}