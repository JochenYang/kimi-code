/**
 * Structured compaction handoff validation and working-set evidence extraction.
 *
 * Full compaction replaces assistant/tool history with a free-form summary.
 * These helpers (1) check that a summary covers required memory sections and
 * (2) pull high-value failure / error evidence from the pre-compact history so
 * it can be re-injected after compaction (not only prose about user messages).
 */

import type { ContentPart } from '#/kosong/contract/message';
import type { ContextMessage } from '#/agent/contextMemory/types';

/** Required conceptual sections a durable handoff should cover. */
export const HANDOFF_REQUIRED_SECTIONS = [
  'intent',
  'constraints',
  'done',
  'open_questions',
  'next_plan',
] as const;

export type HandoffSection = (typeof HANDOFF_REQUIRED_SECTIONS)[number];

export interface HandoffValidationResult {
  readonly ok: boolean;
  readonly missing: readonly HandoffSection[];
  readonly present: readonly HandoffSection[];
  /** Normalized section-tagged body when missing sections were filled with placeholders. */
  readonly normalizedSummary: string;
}

const SECTION_PATTERNS: Readonly<Record<HandoffSection, RegExp>> = {
  intent: /(?:^|\n)\s*(?:#{1,3}\s*)?(?:intent|goal|request|任务|目标|需求)\b/i,
  constraints: /(?:^|\n)\s*(?:#{1,3}\s*)?(?:constraint|constraints|rules|限制|约束)\b/i,
  done: /(?:^|\n)\s*(?:#{1,3}\s*)?(?:done|completed|progress|已完成|进度|what\s+has\s+been\s+done)\b/i,
  open_questions: /(?:^|\n)\s*(?:#{1,3}\s*)?(?:open\s*questions?|unknowns?|gaps?|未知|待确认|还不知道)\b/i,
  next_plan: /(?:^|\n)\s*(?:#{1,3}\s*)?(?:next|plan|forward|下一步|计划|接下来)\b/i,
};

const SECTION_PLACEHOLDERS: Readonly<Record<HandoffSection, string>> = {
  intent: '## Intent\n(unstructured handoff — intent not explicitly sectioned)',
  constraints: '## Constraints\n(unstructured handoff — constraints not explicitly sectioned)',
  done: '## Done\n(unstructured handoff — completed work not explicitly sectioned)',
  open_questions: '## Open questions\n(unstructured handoff — unknowns not explicitly sectioned)',
  next_plan: '## Next plan\n(unstructured handoff — forward plan not explicitly sectioned)',
};

/**
 * Validate that a compaction summary covers required sections.
 * When sections are missing, appends placeholder headings so downstream
 * consumers always see a checkable skeleton (does not invent facts).
 */
export function validateHandoffStructure(summary: string): HandoffValidationResult {
  const body = summary.trim();
  const present: HandoffSection[] = [];
  const missing: HandoffSection[] = [];
  for (const section of HANDOFF_REQUIRED_SECTIONS) {
    if (body.length > 0 && SECTION_PATTERNS[section].test(body)) {
      present.push(section);
    } else {
      missing.push(section);
    }
  }
  if (missing.length === 0) {
    return { ok: true, missing: [], present, normalizedSummary: body };
  }
  const extras = missing.map((section) => SECTION_PLACEHOLDERS[section]).join('\n\n');
  const normalizedSummary =
    body.length > 0 ? `${body}\n\n${extras}` : extras;
  return { ok: false, missing, present, normalizedSummary };
}

export interface WorkingSetEvidenceItem {
  readonly kind: 'tool_error' | 'failure_text';
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly excerpt: string;
}

export interface WorkingSetEvidence {
  readonly items: readonly WorkingSetEvidenceItem[];
  /** Model-visible injection text, or undefined when nothing worth keeping. */
  readonly injectionText: string | undefined;
}

const FAILURE_HINT =
  /(?:error|failed|failure|exception|traceback|assert|ENOENT|EACCES|not found|timeout|拒绝|失败|错误)/i;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EXCERPT_CHARS = 800;

/**
 * Extract high-value failure evidence from pre-compaction history.
 * Prefers tool messages marked isError / ERROR markers and text matching failure hints.
 */
export function extractWorkingSetEvidence(
  history: readonly ContextMessage[],
  maxItems: number = MAX_EVIDENCE_ITEMS,
): WorkingSetEvidence {
  const items: WorkingSetEvidenceItem[] = [];

  for (let i = history.length - 1; i >= 0 && items.length < maxItems; i -= 1) {
    const message = history[i]!;
    if (message.role === 'tool') {
      const text = contentText(message.content);
      const isError =
        message.isError === true ||
        /<system>\s*ERROR:/i.test(text) ||
        FAILURE_HINT.test(text.slice(0, 400));
      if (!isError || text.trim().length === 0) continue;
      items.push({
        kind: 'tool_error',
        toolName: message.name,
        toolCallId: message.toolCallId,
        excerpt: clip(text, MAX_EXCERPT_CHARS),
      });
      continue;
    }
    if (message.role === 'user' || message.role === 'assistant') {
      const text = contentText(message.content);
      if (!FAILURE_HINT.test(text) || text.length < 40) continue;
      // Skip pure system-reminder / injection noise.
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') continue;
      items.push({
        kind: 'failure_text',
        excerpt: clip(text, MAX_EXCERPT_CHARS),
      });
    }
  }

  items.reverse();
  return {
    items,
    injectionText: items.length === 0 ? undefined : renderEvidenceInjection(items),
  };
}

function renderEvidenceInjection(items: readonly WorkingSetEvidenceItem[]): string {
  const lines = [
    '<system-reminder>',
    'Working-set evidence retained across compaction (verify before relying on it):',
  ];
  for (const [index, item] of items.entries()) {
    const label =
      item.kind === 'tool_error'
        ? `tool_error${item.toolName !== undefined ? ` ${item.toolName}` : ''}${item.toolCallId !== undefined ? ` (${item.toolCallId})` : ''}`
        : 'failure_text';
    lines.push(`${String(index + 1)}. [${label}]`);
    lines.push(item.excerpt);
    lines.push('');
  }
  lines.push('</system-reminder>');
  return lines.join('\n').trimEnd();
}

function contentText(content: readonly ContentPart[]): string {
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…[truncated]`;
}
