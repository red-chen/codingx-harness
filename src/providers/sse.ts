export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Incremental SSE parser (text/event-stream). Handles CRLF, comments,
 * multi-line data and chunks split at arbitrary byte boundaries.
 */
export class SseParser {
  private buffer = '';
  private eventName: string | undefined;
  private dataLines: string[] = [];
  private eventId: string | undefined;
  private retry: number | undefined;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  end(): SseEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): SseEvent[] {
    const out: SseEvent[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.processLine(line, out);
    }
    if (final) {
      if (this.buffer.length > 0) {
        let line = this.buffer;
        this.buffer = '';
        if (line.endsWith('\r')) line = line.slice(0, -1);
        this.processLine(line, out);
      }
      this.dispatch(out);
    }
    return out;
  }

  private processLine(line: string, out: SseEvent[]): void {
    if (line.length === 0) {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        this.eventId = value;
        break;
      case 'retry': {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) this.retry = parsed;
        break;
      }
      default:
        break;
    }
  }

  private dispatch(out: SseEvent[]): void {
    if (this.dataLines.length === 0) {
      this.eventName = undefined;
      this.eventId = undefined;
      this.retry = undefined;
      return;
    }
    const event: SseEvent = { data: this.dataLines.join('\n') };
    if (this.eventName !== undefined) event.event = this.eventName;
    if (this.eventId !== undefined) event.id = this.eventId;
    if (this.retry !== undefined) event.retry = this.retry;
    out.push(event);
    this.eventName = undefined;
    this.dataLines = [];
    this.eventId = undefined;
    this.retry = undefined;
  }
}
