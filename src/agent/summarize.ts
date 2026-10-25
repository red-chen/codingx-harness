import type { Message, ModelClient, ModelEvent, TokenUsage } from '../providers/types.js';
import { EMPTY_USAGE, addUsage } from '../providers/types.js';
import { abortError, describeError, isAbortError } from '../util/errors.js';
import { truncateMiddle } from '../util/tokens.js';

/**
 * System prompt for the level-3 compression request.
 *
 * The summary is appended to the system prompt (see AgentLoop) and is the only
 * record of everything dropped, so it has to keep the facts that later steps
 * depend on: commands, paths, errors, decisions and any safety constraint the
 * user stated. The request carries no tools; saying so explicitly keeps a model
 * from spending the single turn on a tool call.
 */
export const SUMMARY_SYSTEM_PROMPT = [
  'You compress conversation history for a coding agent that must keep working from this summary alone.',
  'Output plain text only. Do not call tools: this request has no tools and a tool call would be rejected.',
  '',
  'Use exactly these markdown sections, in this order:',
  '## Completed',
  '- What was done and what was verified, including the command or test that proved it.',
  '## Key files',
  '- Workspace-relative paths, one per line, each with a short note on why it matters.',
  '## Decisions',
  '- Choices already made and why, so they are not re-litigated later.',
  '## Open questions',
  '- What is still unknown, blocked or unverified.',
  '',
  'Rules:',
  '- Keep file paths, commands, error messages, identifiers and numbers verbatim; do not paraphrase them.',
  '- Preserve any user constraint about safety, credentials or destructive operations word for word: ' +
    'it must keep applying after compaction.',
  '- Keep the original user request, shortened only where its wording is not load-bearing.',
  '- Do not invent facts, files or results; put anything unknown under Open questions.',
  '- Output only the summary: no preamble and no closing remarks.',
].join('\n');

export interface SummarizeDroppedOptions {
  router: ModelClient;
  messages: readonly Message[];
  model: string;
  sessionId: string;
  maxOutputTokens?: number;
  maxTranscriptChars?: number;
  signal?: AbortSignal;
}

export interface SummaryOutcome {
  summary?: string;
  usage: TokenUsage;
  error?: { code: string; message: string };
}

function blockText(block: Message['content'][number]): string {
  if (block.type === 'text') {
    return 'text:\n' + truncateMiddle(block.text, 4_000, '\n[... text truncated ...]\n');
  }
  if (block.type === 'tool_use') {
    let input: string;
    try {
      input = JSON.stringify(block.input);
    } catch {
      input = String(block.input);
    }
    return (
      'tool_use ' + block.name + ':\n' +
      truncateMiddle(input, 2_000, '\n[... input truncated ...]\n')
    );
  }
  return (
    'tool_result' + (block.is_error ? ' (error)' : '') + ':\n' +
    truncateMiddle(block.content, 2_000, '\n[... tool output truncated ...]\n')
  );
}

/** Serialize dropped messages into a bounded, role-labelled transcript. */
export function serializeMessagesForSummary(
  messages: readonly Message[],
  maxChars = 24_000,
): string {
  const sections: string[] = [];
  for (const message of messages) {
    sections.push('## ' + message.role + '\n' + message.content.map(blockText).join('\n\n'));
  }
  return truncateMiddle(
    sections.join('\n\n'),
    maxChars,
    '\n[... conversation excerpt truncated ...]\n',
  );
}

/**
 * Level 3: ask the model for a structured summary of messages dropped by the
 * deterministic compressor. The caller must account for the returned usage and
 * treat failures as a fallback (not a failed turn).
 */
export async function summarizeDroppedMessages(options: SummarizeDroppedOptions): Promise<SummaryOutcome> {
  if (options.signal?.aborted) throw abortError();
  if (options.messages.length === 0) return { usage: EMPTY_USAGE };

  const transcript = serializeMessagesForSummary(
    options.messages,
    options.maxTranscriptChars ?? 24_000,
  );
  const request = {
    model: options.model,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: transcript }] }],
    tools: [],
    maxOutputTokens: options.maxOutputTokens ?? 1_200,
    temperature: 0,
    sessionId: options.sessionId,
  };

  let text = '';
  let usage: TokenUsage = EMPTY_USAGE;
  let stopped = false;
  try {
    for await (const event of options.router.stream(request, options.signal)) {
      if (options.signal?.aborted) throw abortError();
      if (event.type === 'text.delta') text += event.text;
      else if (event.type === 'usage') usage = addUsage(usage, event);
      else if (event.type === 'stop') {
        stopped = true;
        if (event.reason === 'refusal') {
          return {
            usage,
            error: { code: 'SUMMARY_REFUSED', message: 'The model refused to summarize the dropped context.' },
          };
        }
      }
    }
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw abortError();
    const summary = describeError(error);
    return { usage, error: { code: summary.code, message: summary.message } };
  }

  const summary = text.trim();
  if (summary.length === 0) {
    return {
      usage,
      error: {
        code: stopped ? 'SUMMARY_EMPTY' : 'SUMMARY_INCOMPLETE',
        message: stopped ? 'The summary response was empty.' : 'The summary stream ended without a stop event.',
      },
    };
  }
  return { summary, usage };
}

/** Exposed for tests/tools that need the raw event shape. */
export type SummaryStreamEvent = ModelEvent;
