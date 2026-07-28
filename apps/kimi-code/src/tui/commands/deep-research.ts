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

  if (result.reportPath !== null) {
    lines.push(`**Full report:** \`${result.reportPath}\``);
  }
  if (result.coverageNotes.length > 0) {
    lines.push('');
    lines.push(`_${String(result.coverageNotes.length)} coverage note(s) — see the full report._`);
  }
  return lines.join('\n');
}

/** Short footer status after the transcript reply is posted. */
export function formatDeepResearchFooter(result: DeepResearchResult): string {
  const statusLabel = result.status.charAt(0).toUpperCase() + result.status.slice(1);
  if (result.reportPath !== null) {
    return `Deep research · ${statusLabel} · full report saved`;
  }
  return `Deep research · ${statusLabel}`;
}

/** @deprecated kept for tests that import the old name */
export function formatDeepResearchStatus(result: DeepResearchResult): string {
  return formatDeepResearchFooter(result);
}
