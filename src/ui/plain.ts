import type { UiEvent } from '../agent/events.js';
import type { ToolCall } from '../providers/types.js';

export interface TextSink {
  write(text: string): unknown;
}

export interface PlainRendererOptions {
  stdout: TextSink;
  stderr: TextSink;
  /** Emit JSON Lines on stdout instead of human-readable text. */
  json?: boolean;
  /** Buffer assistant text and write only the final answer (exec mode). */
  finalOnly?: boolean;
  showBanner?: boolean;
  version?: string;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

function toolLabel(call: ToolCall): string {
  const input =
    typeof call.input === 'object' && call.input !== null ? (call.input as Record<string, unknown>) : {};
  if (call.name === 'Shell' && typeof input.command === 'string') {
    return 'Shell: ' + truncate(input.command, 120);
  }
  if (typeof input.path === 'string') return call.name + ': ' + input.path;
  if (call.name === 'Skill' && typeof input.name === 'string') return 'Skill: ' + input.name;
  if (call.name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const first = input.questions[0];
    if (typeof first === 'object' && first !== null) {
      const question = (first as Record<string, unknown>).question;
      if (typeof question === 'string') return 'ask: ' + truncate(question, 120);
    }
  }
  return call.name;
}

function toolDetail(content: string, isError: boolean | undefined, name: string, durationMs: number): string {
  if (name === 'Shell') {
    const exitLine = content.split('\n').find((line) => line.trimStart().startsWith('exit_code:'));
    if (exitLine) return exitLine.trim();
  }
  const first = content.split('\n').find((line) => line.trim().length > 0) ?? '';
  return (isError ? '✗ ' : '✓ ') + truncate(first, 160) + ' (' + durationMs + 'ms)';
}

function usageLabel(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }): string {
  const cache = usage.cacheReadTokens > 0 ? ', cache read ' + usage.cacheReadTokens : '';
  return '[tokens: in ' + usage.inputTokens + ', out ' + usage.outputTokens + cache + ']';
}

/** M1 line-oriented renderer. Streams assistant text to stdout, progress to stderr. */
export class PlainRenderer {
  private readonly stdout: TextSink;
  private readonly stderr: TextSink;
  private readonly json: boolean;
  private readonly finalOnly: boolean;
  private readonly showBanner: boolean;
  private readonly version: string;
  private wroteText = false;
  private finalText = '';

  constructor(options: PlainRendererOptions) {
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.json = options.json ?? false;
    this.finalOnly = options.finalOnly ?? false;
    this.showBanner = options.showBanner ?? false;
    this.version = options.version ?? '';
  }

  render(event: UiEvent): void {
    if (this.json) {
      this.stdout.write(JSON.stringify(event) + '\n');
      return;
    }

    switch (event.type) {
      case 'session.info':
        if (this.showBanner) {
          this.stdout.write('codingx' + (this.version ? ' ' + this.version : '') + '\n');
          this.stdout.write('model: ' + event.session.model + '\n');
          this.stdout.write('directory: ' + event.session.cwd + '\n\n');
        }
        break;
      case 'turn.started':
        this.wroteText = false;
        this.finalText = '';
        break;
      case 'text.delta':
        if (this.finalOnly) {
          this.finalText += event.text;
        } else {
          this.stdout.write(event.text);
          this.wroteText = true;
        }
        break;
      case 'tool.started':
        if (this.finalOnly) {
          // Text before a tool call is progress narration, not the answer.
          this.finalText = '';
        } else if (this.wroteText) {
          this.stdout.write('\n');
          this.wroteText = false;
        }
        this.stderr.write('• ' + toolLabel(event.call) + '\n');
        break;
      case 'tool.finished':
        this.stderr.write('  └ ' + toolDetail(event.result.content, event.result.isError, event.name, event.durationMs) + '\n');
        break;
      case 'llm.finished':
        break;
      case 'hook.finished':
        if (event.status !== 'ok') {
          this.stderr.write(
            '⚠ hook ' + event.event + ' ' + event.status +
              (event.message === undefined ? '' : ': ' + truncate(event.message, 200)) + '\n',
          );
        }
        break;
      case 'plan.updated':
        this.stderr.write('• Updated Plan\n');
        for (const step of event.steps) {
          const marker = step.status === 'completed' ? '✔' : step.status === 'in_progress' ? '▶' : '□';
          this.stderr.write('  ' + marker + ' ' + step.step + '\n');
        }
        break;
      case 'usage.updated':
        break;
      case 'context.updated':
        break;
      case 'turn.finished':
        if (this.finalOnly) {
          if (event.status === 'done' && this.finalText.length > 0) {
            this.stdout.write(this.finalText);
            if (!this.finalText.endsWith('\n')) this.stdout.write('\n');
          }
          this.finalText = '';
        } else if (this.wroteText) {
          this.stdout.write('\n');
          this.wroteText = false;
        }
        if (event.status === 'aborted') {
          this.stderr.write('[aborted]\n');
        } else if (event.status === 'error') {
          this.stderr.write('[error] ' + (event.error?.code ?? 'ERROR') + ': ' + (event.error?.message ?? 'unknown') + '\n');
        }
        this.stderr.write(usageLabel(event.usage) + '\n');
        break;
    }
  }
}
