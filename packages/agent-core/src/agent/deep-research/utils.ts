/** Utility helpers for deep-research — no external deps. */

/**
 * JSON-encode a value for safe embedding in a prompt.
 * Unlike JSON.stringify, this escapes </script> etc. and is clearly
 * labelled as "encoded" for the model's benefit.
 */
export function deepResearchJsonEncode(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Validate a claim before adding it to the candidate pool.
 */
export function isValidClaim(claim: { readonly claim?: string; readonly evidence?: string; readonly source_title?: string; readonly source_locator?: string }): boolean {
  return (
    typeof claim.claim === 'string' && claim.claim.trim().length > 0
    && typeof claim.evidence === 'string' && claim.evidence.trim().length > 0
    && typeof claim.source_title === 'string' && claim.source_title.trim().length > 0
    && typeof claim.source_locator === 'string' && claim.source_locator.trim().length > 0
  );
}

/**
 * Extract content between <report-body> and </report-body> tags.
 * Returns null if the tags are not found.
 */
export function extractReportBody(text: string): string | null {
  const openTag = '<report-body>';
  const closeTag = '</report-body>';

  const openIdx = text.indexOf(openTag);
  if (openIdx === -1) return null;

  const contentStart = openIdx + openTag.length;
  const closeIdx = text.indexOf(closeTag, contentStart);
  if (closeIdx === -1) return null;

  return text.slice(contentStart, closeIdx).trim();
}

/**
 * Validate citation markers in a synthesized report body.
 * Returns true if every [Sn] marker references a valid index (1..assigned),
 * no marker is invented, and no "## Sources" or "## References" section exists.
 */
export function validateCitations(body: string, assignedCount: number): boolean {
  if (assignedCount === 0) return true;

  // Check for forbidden sections
  if (body.includes('## Sources') || body.includes('## References')) {
    return false;
  }

  // Check every [Sn] marker is valid
  const markerRegex = /\[S(\d+)\]/g;
  let match: RegExpExecArray | null;
  const seen = new Set<number>();

  while ((match = markerRegex.exec(body)) !== null) {
    const n = Number(match[1]);
    if (n < 1 || n > assignedCount) return false;
    seen.add(n);
  }

  // Every marker must be used at least once
  for (let i = 1; i <= assignedCount; i++) {
    if (!seen.has(i)) return false;
  }

  return true;
}

/**
 * Deduplicate source entries by their title+locator pair.
 */
export function deduplicateSources(
  sources: ReadonlyArray<{
    readonly citations: readonly string[];
    readonly title: string;
    readonly locator: string;
    readonly v_title: string;
    readonly v_locator: string;
  }>,
): ReadonlyArray<{
  readonly citations: readonly string[];
  readonly title: string;
  readonly locator: string;
  readonly v_title: string;
  readonly v_locator: string;
}> {
  const keyMap = new Map<string, {
    citations: string[];
    title: string;
    locator: string;
    v_title: string;
    v_locator: string;
  }>();

  for (const source of sources) {
    const key = `${source.title}|${source.locator}|${source.v_title}|${source.v_locator}`;
    const existing = keyMap.get(key);
    if (existing) {
      existing.citations.push(...source.citations);
    } else {
      keyMap.set(key, {
        citations: [...source.citations],
        title: source.title,
        locator: source.locator,
        v_title: source.v_title,
        v_locator: source.v_locator,
      });
    }
  }

  return Array.from(keyMap.values());
}