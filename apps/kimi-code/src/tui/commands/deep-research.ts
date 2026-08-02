import type { DeepResearchResult } from '@moonshot-ai/kimi-code-sdk';

import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import type { TranscriptEntry } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';

/** Soft cap so a huge report still fits as a readable main-thread reply. */
const MAX_TRANSCRIPT_CHARS = 12_000;

export async function handleDeepResearchCommand(host: SlashCommandHost, args: string): Promise<void> {
  const query = args.trim();

  if (query.length === 0) {
    host.showStatus('Provide a research query, e.g. `/deep-research Compare PostgreSQL 17 and MySQL 9`.');
    return;
  }

  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  host.track('input_command', { command: 'deep-research' });

  // Show the user's research request in the main transcript (slash commands
  // do not go through sendNormalUserInput).
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'user',
    renderMode: 'plain',
    content: `/deep-research ${query}`,
  });

  // Deep research has no main turn, so mirror a normal request's busy signals:
  // activity spinner, terminal tab progress, Esc→session.cancel→deepResearchAbort,
  // and input queueing via streamingPhase !== 'idle'.
  host.beginSessionRequest();

  try {
    // Phase progress is emitted as warning events (code: deep-research-progress)
    // from the agent so it survives RPC JSON clone. SessionEventHandler renders
    // those once — do not also pass onProgress→showStatus or status lines double.
    host.showStatus('Deep research · starting… Press Esc to cancel.');
    const result: DeepResearchResult = await session.startDeepResearch(query);

    if (result.status === 'cancelled') {
      host.showStatus('Deep research was cancelled.');
      host.appendTranscriptEntry(statusEntry('Deep research was cancelled.'));
      return;
    }

    // Main-thread reply: markdown report body as an assistant message so it
    // reads like a normal agent answer, not only a footer status line.
    host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'assistant',
      renderMode: 'markdown',
      content: formatDeepResearchTranscript(result),
      // Not model-streamed text; /copy still works via content, but this is a
      // derived card from the deep-research pipeline.
      modelText: false,
    });
    host.showStatus(formatDeepResearchFooter(result));
  } catch (error) {
    host.failSessionRequest(`Deep research failed: ${formatErrorMessage(error)}`);
    return;
  } finally {
    // No main turn.ended will clear busy — always release spinner / tab progress.
    // failSessionRequest already idles; this is idempotent for the success path.
    if (host.state.appState.streamingPhase !== 'idle') {
      host.setAppState({ streamingPhase: 'idle' });
      host.resetLivePane();
    }
  }
}

function statusEntry(content: string): TranscriptEntry {
  return {
    id: nextTranscriptId(),
    kind: 'status',
    renderMode: 'notice',
    content,
  };
}

/** Full-ish body for the main transcript assistant bubble. */
export function formatDeepResearchTranscript(result: DeepResearchResult): string {
  const statusLabel = result.status.charAt(0).toUpperCase() + result.status.slice(1);
  const lines: string[] = [`# Deep research · ${statusLabel}`, ''];

  const body = result.chatReport.trim();
  if (body.length > 0) {
    lines.push(
      body.length > MAX_TRANSCRIPT_CHARS
        ? `${body.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n…(truncated; see full report file)`
        : body,
    );
    lines.push('');
  }

  // Attach the Sources lookup so [S1]-style markers in the body are readable
  // in place instead of dangling until the user opens the report file. The
  // report file keeps full titles/URLs; the bubble compresses each entry to a
  // single line so long search-snapshot URLs do not flood the transcript.
  const sources = extractSourcesSection(result.report);
  if (sources !== null) {
    lines.push(`## Sources\n${compressSourcesSection(sources)}`);
    lines.push('');
  }

  if (result.reportPath !== null) {
    lines.push(`**Full report:** \`${result.reportPath}\``);
  }
  if (result.coverageNotes.length > 0) {
    lines.push('');
    lines.push(`_${String(result.coverageNotes.length)} coverage note(s) — see the full report._`);
  }
  return lines.join('\n');
}

/** Extract the "## Sources" list section from the full report markdown. */
function extractSourcesSection(report: string): string | null {
  const marker = '## Sources';
  const start = report.indexOf(marker);
  if (start === -1) return null;
  const firstLineEnd = report.indexOf('\n', start);
  if (firstLineEnd === -1) return null;
  const nextHeading = report.indexOf('\n## ', firstLineEnd + 1);
  const end = nextHeading === -1 ? report.length : nextHeading;
  const section = report.slice(firstLineEnd + 1, end).trim();
  return section.length > 0 ? section : null;
}

/** Hard caps so one bloated entry cannot flood the transcript bubble. */
const SOURCES_TITLE_MAX = 60;
const SOURCES_LOCATOR_MAX = 100;

/**
 * Compress the report's multi-line Sources section into one readable line per
 * entry: `- [S1] title — locator`, titles/URLs truncated, verifier cross-check
 * text dropped (it stays in the full report file). Tolerates the legacy
 * single-line `title — locator` form as well.
 */
function compressSourcesSection(section: string): string {
  const entries = new Map<number, { ids: string; title: string; locator: string }>();
  let current: { ids: string; title: string; locator: string } | undefined;

  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    const entryMatch = line.match(/^- ((\[S\d+\](?: \[S\d+\])*)) (.*)$/);
    if (entryMatch !== null) {
      const index = Number(line.match(/\[S(\d+)\]/)?.[1]);
      current = { ids: entryMatch[1]!, title: entryMatch[3]!, locator: '' };
      if (index !== undefined && Number.isFinite(index)) {
        entries.set(index, current);
      }
      continue;
    }
    if (current !== undefined && line.length > 0) {
      if (current.locator === '') {
        current.locator = line.startsWith('independently checked against:')
          ? current.locator
          : line;
      }
      // Any further continuation lines (verifier cross-check) are ignored.
    }
  }

  const lines: string[] = [];
  for (const index of [...entries.keys()].sort((a, b) => a - b)) {
    const entry = entries.get(index)!;
    let title = entry.title;
    let locator = entry.locator;
    if (locator === '') {
      // Legacy single-line form: `title — locator (independently checked …)`.
      const cut = title.indexOf(' (independently checked');
      if (cut !== -1) title = title.slice(0, cut);
      const separator = title.lastIndexOf(' — ');
      if (separator !== -1) {
        locator = title.slice(separator + 3).trim();
        title = title.slice(0, separator).trim();
      }
    }
    lines.push(`- ${entry.ids} ${truncateMiddle(title, SOURCES_TITLE_MAX)} — ${truncateMiddle(locator, SOURCES_LOCATOR_MAX)}`);
  }
  return lines.join('\n');
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  const keep = Math.max(1, max - 1);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** Short footer status after the transcript reply is posted. */
export function formatDeepResearchFooter(result: DeepResearchResult): string {
  const statusLabel = result.status.charAt(0).toUpperCase() + result.status.slice(1);
  if (result.reportPath !== null) {
    return `Deep research · ${statusLabel} · full report saved`;
  }
  return `Deep research · ${statusLabel}`;
}
