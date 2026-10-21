export function deepResearchJsonEncode(value: unknown): string {
  return JSON.stringify(value);
}

export function isValidClaim(claim: { readonly claim?: string; readonly evidence?: string; readonly source_title?: string; readonly source_locator?: string }): boolean {
  return (
    typeof claim.claim === 'string' && claim.claim.trim().length > 0
    && typeof claim.evidence === 'string' && claim.evidence.trim().length > 0
    && typeof claim.source_title === 'string' && claim.source_title.trim().length > 0
    && typeof claim.source_locator === 'string' && claim.source_locator.trim().length > 0
  );
}

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

export function validateCitations(body: string, assignedCount: number): boolean {
  if (assignedCount === 0) return true;

  if (body.includes('## Sources') || body.includes('## References')) {
    return false;
  }

  const markerRegex = /\[S(\d+)\]/g;
  let match: RegExpExecArray | null;
  const seen = new Set<number>();

  while ((match = markerRegex.exec(body)) !== null) {
    const n = Number(match[1]);
    if (n < 1 || n > assignedCount) return false;
    seen.add(n);
  }

  for (let i = 1; i <= assignedCount; i++) {
    if (!seen.has(i)) return false;
  }

  return true;
}

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
