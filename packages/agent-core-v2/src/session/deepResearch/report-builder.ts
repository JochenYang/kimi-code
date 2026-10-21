import { deduplicateSources } from './utils';
import type { VerifiedClaim, DeepResearchStatus } from './types';

export interface ReportInput {
  readonly status: DeepResearchStatus;
  readonly body: string;
  readonly verifiedClaims: readonly VerifiedClaim[];
  readonly coverageNotes: readonly string[];
}

export function buildFullReport(input: ReportInput): string {
  const statusLabel = input.status === 'verified' ? 'Verified' : 'Partial';

  let report = `# Research result\n\n**Status: ${statusLabel}**\n\n`;
  report += linkCitations(input.body, buildSourceLinks(input.verifiedClaims));
  report += '\n';

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
    report += `- ${ids} ${row.title}\n`;
    report += `  ${row.locator}\n`;
  }

  report += '\n## Coverage and uncertainty\n';
  report += buildCoverageSection(input.coverageNotes);

  return report;
}

export function buildChatReport(body: string, partial: boolean, verifiedClaims: readonly VerifiedClaim[]): string {
  const linked = linkCitations(body, buildSourceLinks(verifiedClaims));
  if (partial) {
    return `**Status: Partial** — see the full report for coverage gaps.\n\n${linked}`;
  }
  return linked;
}

export function linkCitations(body: string, links: ReadonlyMap<string, string>): string {
  return body.replaceAll(/\[(S\d+)\]/g, (marker, id: string) => {
    const url = links.get(id);
    if (url === undefined) return marker;
    return `[${id}](<${url}>)`;
  });
}

function buildSourceLinks(claims: readonly VerifiedClaim[]): Map<string, string> {
  const links = new Map<string, string>();
  claims.forEach((claim, i) => {
    links.set(`S${String(i + 1)}`, claim.original_source_locator);
  });
  return links;
}

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
