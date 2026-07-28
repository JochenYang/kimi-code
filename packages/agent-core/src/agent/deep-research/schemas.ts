/**
 * Zod schemas for deep-research structured output parsing.
 * Each phase's agent output is validated against these schemas.
 */

import { z } from 'zod';

// ── Plan phase ───────────────────────────────────────────────────────────────

export const PlanOutputSchema = z.object({
  questions: z
    .array(z.string().min(1))
    .min(1)
    .max(6)
    .describe('Independent questions that together answer the research query'),
});

export type PlanOutput = z.infer<typeof PlanOutputSchema>;

// ── Research phase ────────────────────────────────────────────────────────────

export const ClaimSchema = z.object({
  claim: z.string().min(1),
  evidence: z.string().min(1),
  source_title: z.string().min(1),
  source_locator: z.string().min(1),
  source_type: z.enum(['primary', 'secondary', 'repository', 'other']),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const ResearchOutputSchema = z.object({
  claims: z.array(ClaimSchema).max(6),
  uncertainties: z.array(z.string()).max(6),
});

export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

// ── Verify phase ─────────────────────────────────────────────────────────────

export const VerdictSchema = z.object({
  claim_id: z.string().min(1),
  supported: z.boolean(),
  reason: z.string().min(1),
  evidence: z.string().optional(),
  source_title: z.string().optional(),
  source_locator: z.string().optional(),
});

export const VerifyOutputSchema = z.object({
  verdicts: z.array(VerdictSchema).max(12),
});

export type VerifyOutput = z.infer<typeof VerifyOutputSchema>;

/**
 * Try to parse a JSON object from a subagent's output text.
 * Handles fenced JSON blocks (```json ... ```) and bare JSON.
 */
export function tryParseJson<T>(text: string, schema: z.ZodSchema<T>): { ok: true; data: T } | { ok: false; error: string } {
  const candidates = extractJsonCandidates(text);
  let lastError = 'No JSON object found in agent output';

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const result = schema.safeParse(parsed);
      if (result.success) {
        return { ok: true, data: result.data };
      }
      lastError = `Schema validation failed: ${result.error.message}`;
    } catch (error) {
      lastError = `JSON parse error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return { ok: false, error: lastError };
}

/** Prefer fenced blocks, then the largest top-level `{...}` slice. */
function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1] !== undefined) {
    out.push(fenceMatch[1].trim());
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    out.push(trimmed);
  } else {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      out.push(text.slice(start, end + 1).trim());
    }
  }
  return out;
}