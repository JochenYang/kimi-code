import { createHash } from 'node:crypto';

import type { Message } from '#/llm-adapter/contract/message';
import { estimateTokensForMessage, estimateTokensForMessages } from '#/llm-adapter/contract/tokens';

export const CONTENT_PROJECTION_SOFT_THRESHOLD_RATIO = 0.6;
export const CONTENT_PROJECTION_DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const CONTENT_PROJECTION_KEEP_RECENT_WINDOW_RATIO = 0.2;

const REPEAT_FOLD_MIN_CHARS = 200;
const LARGE_RESULT_MIN_CHARS = 4_000;
const HEAD_CHARS = 800;
const TAIL_CHARS = 800;
const MAX_SALIENT_LINES = 20;
const SALIENT_LINE_MAX_CHARS = 400;

const REPEAT_MARKER_PREFIX = '[repeated:';
const CUT_MARKER_PREFIX = '[context-condensed:';

const SALIENT_LINE_REGEX =
  /error|fail|test|exit|path|diff|warning|traceback|File "|-->|[^\s()]+\.[A-Za-z0-9_]+:\d+|[^\s()]+\(\d+\)/;

export interface ContentProjectionOptions {
  readonly contextWindow: number;
  readonly keepRecentTokens?: number;
}

export interface ContentProjectionStats {
  readonly applied: boolean;
  readonly skippedReason?: string;
  readonly originalTokens: number;
  readonly projectedTokens: number;
  readonly originalChars: number;
  readonly projectedChars: number;
  readonly repeatedFolds: number;
  readonly largeCuts: number;
  readonly invariantViolation?: string;
}

export interface ContentProjectionResult {
  readonly messages: readonly Message[];
  readonly stats: ContentProjectionStats;
}

export function resolveKeepRecentTokens(
  options: ContentProjectionOptions,
): number {
  const requested = options.keepRecentTokens ?? CONTENT_PROJECTION_DEFAULT_KEEP_RECENT_TOKENS;
  const windowCap = Math.floor(options.contextWindow * CONTENT_PROJECTION_KEEP_RECENT_WINDOW_RATIO);
  return Math.max(0, Math.min(requested, windowCap));
}

export function computeContentProtection(
  messages: readonly Message[],
  keepRecentTokens: number,
): ReadonlySet<number> {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }
  let tailStart = 0;
  if (keepRecentTokens > 0) {
    let accumulated = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      accumulated += estimateTokensForMessage(messages[i]!);
      tailStart = i;
      if (accumulated >= keepRecentTokens) break;
    }
  }
  const activeStart = lastAssistantIndex === -1 ? messages.length : lastAssistantIndex;
  const protectedFrom = Math.min(activeStart, tailStart);
  const protectedIndexes = new Set<number>();
  for (let i = Math.max(0, protectedFrom); i < messages.length; i += 1) {
    protectedIndexes.add(i);
  }
  return protectedIndexes;
}

export function foldRepeatedToolOutputs(
  messages: readonly Message[],
  protection: ReadonlySet<number>,
): { readonly messages: readonly Message[]; readonly folds: number } {
  const firstIndexByHash = new Map<string, number>();
  let folds = 0;
  const result = messages.map((message, index): Message => {
    if (message.role !== 'tool' || protection.has(index)) return message;
    if (message.content.some((part) => part.type !== 'text')) return message;
    const text = toolResultText(message);
    if (text.length < REPEAT_FOLD_MIN_CHARS) return message;
    const hash = shortContentHash(text);
    const firstIndex = firstIndexByHash.get(hash);
    if (firstIndex === undefined) {
      firstIndexByHash.set(hash, index);
      return message;
    }
    folds += 1;
    const marker =
      `${REPEAT_MARKER_PREFIX} identical tool output already present earlier in this ` +
      `conversation; hash=${hash}; original_chars=${text.length}]`;
    return { ...message, content: [{ type: 'text', text: marker }] };
  });
  return { messages: folds === 0 ? messages : result, folds };
}

export function cutAgedLargeToolOutputs(
  messages: readonly Message[],
  protection: ReadonlySet<number>,
): { readonly messages: readonly Message[]; readonly cuts: number } {
  let cuts = 0;
  const result = messages.map((message, index): Message => {
    if (message.role !== 'tool' || protection.has(index)) return message;
    if (message.content.some((part) => part.type !== 'text')) return message;
    const text = toolResultText(message);
    if (text.length < LARGE_RESULT_MIN_CHARS) return message;
    if (text.includes(CUT_MARKER_PREFIX)) return message;
    const condensed = condenseText(text);
    if (condensed === undefined) return message;
    cuts += 1;
    return { ...message, content: [{ type: 'text', text: condensed }] };
  });
  return { messages: cuts === 0 ? messages : result, cuts };
}

export function verifyContentProjectionInvariants(
  original: readonly Message[],
  projected: readonly Message[],
  protection: ReadonlySet<number>,
): string | undefined {
  if (original.length !== projected.length) return 'message-count-changed';
  for (let i = 0; i < original.length; i += 1) {
    const before = original[i]!;
    const after = projected[i]!;
    if (before.role !== after.role) return `role-changed@${i}`;
    if (before.role === 'tool' && before.toolCallId !== after.toolCallId) {
      return `tool-call-id-changed@${i}`;
    }
    if (before.role === 'assistant' && before.toolCalls !== after.toolCalls) {
      return `tool-calls-modified@${i}`;
    }
    if (after.role === 'tool' && after.content.length === 0) return `empty-tool-content@${i}`;
    if (protection.has(i) && before !== after) return `protected-message-modified@${i}`;
  }
  return undefined;
}

export function applyContentProjection(
  messages: readonly Message[],
  options: ContentProjectionOptions,
): ContentProjectionResult {
  const originalTokens = estimateTokensForMessages(messages);
  const originalChars = totalContentChars(messages);
  const base = {
    originalTokens,
    projectedTokens: originalTokens,
    originalChars,
    projectedChars: originalChars,
    repeatedFolds: 0,
    largeCuts: 0,
  };
  const skip = (skippedReason: string): ContentProjectionResult => ({
    messages,
    stats: { ...base, applied: false, skippedReason },
  });
  if (messages.length === 0) return skip('empty-messages');
  if (!(options.contextWindow > 0)) return skip('no-context-window');
  if (originalTokens <= options.contextWindow * CONTENT_PROJECTION_SOFT_THRESHOLD_RATIO) {
    return skip('below-soft-threshold');
  }

  const protection = computeContentProtection(messages, resolveKeepRecentTokens(options));
  const folded = foldRepeatedToolOutputs(messages, protection);
  const cut = cutAgedLargeToolOutputs(folded.messages, protection);
  if (folded.folds === 0 && cut.cuts === 0) return skip('no-reducible-content');

  const projected = cut.messages;
  const violation = verifyContentProjectionInvariants(messages, projected, protection);
  if (violation !== undefined) {
    return {
      messages,
      stats: {
        ...base,
        applied: false,
        repeatedFolds: folded.folds,
        largeCuts: cut.cuts,
        invariantViolation: violation,
      },
    };
  }
  return {
    messages: projected,
    stats: {
      ...base,
      applied: true,
      projectedTokens: estimateTokensForMessages(projected),
      projectedChars: totalContentChars(projected),
      repeatedFolds: folded.folds,
      largeCuts: cut.cuts,
    },
  };
}

function condenseText(text: string): string | undefined {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return undefined;
  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  const middle = text.slice(HEAD_CHARS, text.length - TAIL_CHARS);
  const salient = salientLinesOf(middle);
  const omitted = middle.length - salient.chars;
  if (omitted <= 0) return undefined;
  const sections = [
    head,
    `${CUT_MARKER_PREFIX} omitted ${omitted} characters; ${salient.lines.length} salient lines kept ...]`,
    ...salient.lines,
    '[... omitted middle ends; tail follows ...]',
    tail,
    '[re-run the command with narrower output, or Read the output_path file when the result references one, to see the omitted middle]',
  ];
  return sections.join('\n');
}

function salientLinesOf(middle: string): { readonly lines: string[]; readonly chars: number } {
  const lines: string[] = [];
  let chars = 0;
  for (const line of middle.split('\n')) {
    if (lines.length >= MAX_SALIENT_LINES) break;
    if (line.length === 0) continue;
    const probe =
      line.length > SALIENT_LINE_MAX_CHARS ? line.slice(0, SALIENT_LINE_MAX_CHARS) : line;
    if (!SALIENT_LINE_REGEX.test(probe)) continue;
    chars += line.length + 1;
    lines.push(
      line.length > SALIENT_LINE_MAX_CHARS ? `${line.slice(0, SALIENT_LINE_MAX_CHARS)}…` : line,
    );
  }
  return { lines, chars };
}

function toolResultText(message: Message): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function totalContentChars(messages: readonly Message[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'text') chars += part.text.length;
    }
  }
  return chars;
}

function shortContentHash(text: string): string {
  return createHash('sha256').update(normalizeForHash(text)).digest('hex').slice(0, 16);
}

function normalizeForHash(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}
