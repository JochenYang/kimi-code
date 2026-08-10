/**
 * `deepResearch` domain — report building: the full markdown report (written
 * to the scratch file) and the shorter chat report for inline display.
 *
 * Reading experience is the priority: every `[Sn]` citation in the body is
 * linked to its actual source URL (clickable in the TUI and in markdown
 * viewers), the Sources section stays one entry per line (no verification
 * process noise), and coverage notes are grouped per research question.
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
  report += linkCitations(input.body, buildSourceLinks(input.verifiedClaims));
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
    // One entry per line: titles and locators are often long (search-snapshot
    // URLs, multi-source titles), so keep the fields on separate lines. The
    // body's [Sn] markers link straight to `row.locator`, so the reader does
    // not need to come back here while reading.
    report += `- ${ids} ${row.title}\n`;
    report += `  ${row.locator}\n`;
  }

  // ── Coverage and uncertainty ─────────────────────────────────────────
  report += '\n## Coverage and uncertainty\n';
  report += buildCoverageSection(input.coverageNotes);

  return report;
}

/**
 * Build a shorter chat report body for inline display.
 * For partial results, prefixes with a status warning.
 */
export function buildChatReport(body: string, partial: boolean, verifiedClaims: readonly VerifiedClaim[]): string {
  const linked = linkCitations(body, buildSourceLinks(verifiedClaims));
  if (partial) {
    return `**Status: Partial** — see the full report for coverage gaps.\n\n${linked}`;
  }
  return linked;
}

/**
 * Map `[Sn]` markers in a report body to their source URL, turning each
 * citation into a clickable markdown link (`[S1](<https://…>)`). Markers
 * without a known source (invented by the model) stay untouched.
 */
export function linkCitations(body: string, links: ReadonlyMap<string, string>): string {
  return body.replace(/\[(S\d+)\]/g, (marker, id: string) => {
    const url = links.get(id);
    if (url === undefined) return marker;
    return `[${id}](<${url}>)`;
  });
}

/**
 * Source-URL lookup for citation ids: citations are numbered by claim order
 * (`S1..Sn`), so the map is the claims' original source locators by index.
 */
function buildSourceLinks(claims: readonly VerifiedClaim[]): Map<string, string> {
  const links = new Map<string, string>();
  claims.forEach((claim, i) => {
    links.set(`S${String(i + 1)}`, claim.original_source_locator);
  });
  return links;
}

/**
 * Coverage notes come out of the orchestrator prefixed with
 * "Question N uncertainty: " — group them under `### Question N` headings so
 * the gaps are scannable per research question. Unprefixed notes stay flat.
 */
function buildCoverageSection(notes: readonly string[]): string {
  if (notes.length === 0) {
    return '- All planned questions returned usable structured research, and every retained claim passed its assigned verifier shard.\n';
  }
  const groups = new Map<string, string[]>();
  const flat: string[] = [];
  for (const note of notes) {
    const match = /^Question (\d+) uncertainty: (.*)$/.exec(note);
    if (match === null) {
      flat.push(note);
      continue;
    }
    const key = `Question ${match[1]}`;
    const detail = match[2];
    if (detail === undefined) continue;
    let items = groups.get(key);
    if (items === undefined) {
      items = [];
      groups.set(key, items);
    }
    items.push(detail);
  }
  let out = '';
  for (const [question, items] of groups) {
    out += `### ${question}\n`;
    for (const item of items) out += `- ${item}\n`;
  }
  for (const note of flat) out += `- ${note}\n`;
  return out;
}
