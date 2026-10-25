import { loadConfig } from '../../config/index.js';
import { EmbeddedSessionStore, type RolloutEvent } from '../../session/index.js';
import type { TextSink } from '../../ui/plain.js';

export interface LogCommandOptions {
  sessionId: string;
  cwd?: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  stdout?: TextSink;
  stderr?: TextSink;
}

function value(event: RolloutEvent, key: string): string {
  const item = event[key];
  return typeof item === 'string' ? item : '';
}

function oneLine(text: string, max = 200): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : compact.slice(0, max - 1) + '…';
}

export function formatEvent(event: RolloutEvent): string {
  const head = '#' + event.seq + ' ' + event.ts + ' ' + event.type;
  switch (event.type) {
    case 'session.start':
      return (
        head +
        '  cwd=' + value(event, 'cwd') +
        ' model=' + value(event, 'model') +
        (value(event, 'provider') ? ' provider=' + value(event, 'provider') : '')
      );
    case 'user.message':
      return head + '  ' + oneLine(value(event, 'text'));
    case 'assistant.message': {
      const calls = Array.isArray(event.calls) ? event.calls.length : 0;
      return head + '  ' + oneLine(value(event, 'text')) + (calls > 0 ? '  (tool calls: ' + calls + ')' : '');
    }
    case 'tool.call':
      return head + '  ' + value(event, 'name') + ' ' + JSON.stringify(event.input ?? {});
    case 'tool.result':
      return (
        head +
        '  ' + value(event, 'name') +
        (event.isError ? ' [error]' : '') +
        '  ' + oneLine(value(event, 'content'))
      );
    case 'turn.start':
      return head + '  turn=' + value(event, 'turnId');
    case 'turn.status':
      return head + '  ' + value(event, 'status');
    case 'turn.end':
      return head + '  status=' + value(event, 'status') + ' steps=' + String(event.steps ?? '?');
    case 'turn.aborted':
      return head + '  reason=' + oneLine(value(event, 'reason'));
    case 'provider.selected':
      return (
        head +
        '  ' + value(event, 'provider') + '/' + value(event, 'model') +
        ' route=' + value(event, 'route')
      );
    case 'model.changed':
      return (
        head +
        '  model=' + value(event, 'model') +
        ' effort=' + (typeof event.reasoningEffort === 'string' ? event.reasoningEffort : 'default')
      );
    case 'plan.updated': {
      const steps = Array.isArray(event.steps) ? event.steps : [];
      const rendered = steps
        .map((step) => {
          if (typeof step !== 'object' || step === null) return '';
          const item = step as Record<string, unknown>;
          const mark = item.status === 'completed' ? '✔' : item.status === 'in_progress' ? '▶' : '□';
          return mark + ' ' + String(item.step ?? '');
        })
        .filter((line) => line.length > 0)
        .join(' / ');
      return head + '  ' + rendered;
    }
    case 'context.compacted':
      return (
        head +
        '  levels=' + (Array.isArray(event.levels) ? event.levels.join('+') : '') +
        ' dropped=' + String(event.droppedMessages ?? 0) +
        (typeof event.summary === 'string' ? '  summary=yes' : '')
      );
    case 'session.end':
      return head + '  ' + (value(event, 'reason') || 'ended');
    default:
      return head;
  }
}

/** codingx log: replay a rollout directly from JSONL, without sessiond or a provider. */
export async function runLog(options: LogCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const loaded = await loadConfig({ cwd: options.cwd ?? process.cwd(), env });
  const store = new EmbeddedSessionStore({ directory: loaded.config.session.dir });
  const events = await store.replaySession(options.sessionId);
  if (options.json) {
    for (const event of events) stdout.write(JSON.stringify(event) + '\n');
  } else {
    for (const event of events) stdout.write(formatEvent(event) + '\n');
  }
  return 0;
}
