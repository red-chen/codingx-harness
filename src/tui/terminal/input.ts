import { graphemeSegments } from './width.js';

export interface KeyMods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface KeyEvent {
  type: 'key';
  code: string;
  text?: string;
  mods: KeyMods;
}

export interface WheelEvent {
  type: 'wheel';
  direction: 'up' | 'down';
}

export interface MouseEvent {
  type: 'mouse';
  action: 'press' | 'drag' | 'release';
  button: number;
  /** 1-based screen column/row from the terminal. */
  x: number;
  y: number;
}

export interface PasteEvent {
  type: 'paste';
  text: string;
}

export interface ResizeEvent {
  type: 'resize';
  columns: number;
  rows: number;
}

export interface FocusEvent {
  type: 'focus';
  focused: boolean;
}

export type InputEvent = KeyEvent | MouseEvent | WheelEvent | PasteEvent | ResizeEvent | FocusEvent;

/** Milliseconds an ESC may sit unresolved before the app calls flushPending(). */
export const ESCAPE_TIMEOUT_MS = 50;

const ESC = '\x1b';
const PASTE_END = '\x1b[201~';

function noMods(): KeyMods {
  return { ctrl: false, alt: false, shift: false, meta: false };
}

function keyEvent(code: string, mods: KeyMods = noMods(), text?: string): KeyEvent {
  const event: KeyEvent = { type: 'key', code, mods };
  if (text !== undefined) event.text = text;
  return event;
}

function modifiersFromXterm(parameter: number | undefined): KeyMods {
  const mods = noMods();
  if (parameter === undefined || !Number.isFinite(parameter) || parameter <= 1) return mods;
  const bits = Math.trunc(parameter) - 1;
  mods.shift = (bits & 1) !== 0;
  mods.alt = (bits & 2) !== 0;
  mods.ctrl = (bits & 4) !== 0;
  mods.meta = (bits & 8) !== 0;
  return mods;
}

function parseParameter(parameter: string): number {
  if (parameter === '' || !/^\d+$/.test(parameter)) return Number.NaN;
  return Number(parameter);
}

interface PlainToken {
  event: InputEvent;
  length: number;
}

function takeGrapheme(text: string): { raw: string; length: number } {
  const firstCode = text.charCodeAt(0);
  if (firstCode < 0x80) {
    const next = text.charCodeAt(1);
    if (text.length === 1 || next < 0x80) return { raw: text[0] ?? '', length: 1 };
  }

  const prefix = text.slice(0, 256);
  const first = graphemeSegments(prefix)[0];
  if (first !== undefined) return { raw: first, length: first.length };
  const codePoint = text.codePointAt(0);
  if (codePoint === undefined) return { raw: '', length: 1 };
  const raw = String.fromCodePoint(codePoint);
  return { raw, length: raw.length };
}

function plainPrintableToken(text: string): PlainToken {
  const { raw, length } = takeGrapheme(text);
  const firstCode = raw.codePointAt(0) ?? 0;
  const isUpper = firstCode >= 0x41 && firstCode <= 0x5a;
  const isLower = firstCode >= 0x61 && firstCode <= 0x7a;
  const isLetter = isUpper || isLower;

  if (raw === ' ') {
    return { event: keyEvent('space', noMods(), ' '), length };
  }

  const mods = noMods();
  mods.shift = isUpper;
  const code = isLetter ? raw.slice(0, 1).toLowerCase() : raw;
  return { event: keyEvent(code, mods, raw), length };
}

function plainControlToken(text: string): PlainToken | undefined {
  const code = text.charCodeAt(0);
  if (code === 0x0d) {
    // Treat CRLF as one Enter; a bare CR is the normal raw-mode Enter.
    if (text.charCodeAt(1) === 0x0a) return { event: keyEvent('enter'), length: 2 };
    return { event: keyEvent('enter'), length: 1 };
  }
  if (code === 0x0a) {
    // LF is Ctrl+J in raw mode; Enter is CR. Keep them distinguishable.
    const mods = noMods();
    mods.ctrl = true;
    return { event: keyEvent('j', mods), length: 1 };
  }
  if (code === 0x09) return { event: keyEvent('tab'), length: 1 };
  if (code === 0x08 || code === 0x7f) return { event: keyEvent('backspace'), length: 1 };

  if (code === 0x00) {
    const mods = noMods();
    mods.ctrl = true;
    return { event: keyEvent('space', mods), length: 1 };
  }
  if (code >= 0x01 && code <= 0x1a) {
    const mods = noMods();
    mods.ctrl = true;
    return { event: keyEvent(String.fromCharCode(0x61 + code - 1), mods), length: 1 };
  }
  if (code >= 0x1c && code <= 0x1f) {
    const mods = noMods();
    mods.ctrl = true;
    const symbols = ['\\', ']', '^', '_'];
    return { event: keyEvent(symbols[code - 0x1c] ?? '', mods), length: 1 };
  }
  return undefined;
}

/** Parse one plain (non-ESC-prefixed) key from the start of text. */
function plainToken(text: string): PlainToken | undefined {
  const code = text.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return plainControlToken(text);
  return plainPrintableToken(text);
}

function keyFromCsi(final: string, params: string, events: InputEvent[]): void {
  const values = params === '' ? [] : params.split(';').map(parseParameter);
  const first = values[0];
  const mods = modifiersFromXterm(values.length >= 2 ? values[1] : undefined);

  switch (final) {
    case 'A':
      events.push(keyEvent('up', mods));
      return;
    case 'B':
      events.push(keyEvent('down', mods));
      return;
    case 'C':
      events.push(keyEvent('right', mods));
      return;
    case 'D':
      events.push(keyEvent('left', mods));
      return;
    case 'H':
      events.push(keyEvent('home', mods));
      return;
    case 'F':
      events.push(keyEvent('end', mods));
      return;
    case 'Z': {
      const shiftTab = noMods();
      shiftTab.shift = true;
      events.push(keyEvent('tab', shiftTab));
      return;
    }
    case 'I':
      events.push({ type: 'focus', focused: true });
      return;
    case 'O':
      events.push({ type: 'focus', focused: false });
      return;
    case 'P':
      events.push(keyEvent('f1', mods));
      return;
    case 'Q':
      events.push(keyEvent('f2', mods));
      return;
    case 'R':
      events.push(keyEvent('f3', mods));
      return;
    case 'S':
      events.push(keyEvent('f4', mods));
      return;
    case '~': {
      if (first === undefined || !Number.isFinite(first)) return;
      const key = Math.trunc(first);
      if (key === 200) {
        // Handled by the parser, which flips into paste mode.
        return;
      }
      const keyCodes: Record<number, string> = {
        1: 'home',
        2: 'insert',
        3: 'delete',
        4: 'end',
        5: 'pageup',
        6: 'pagedown',
        7: 'home',
        8: 'end',
        11: 'f1',
        12: 'f2',
        13: 'f3',
        14: 'f4',
        15: 'f5',
        17: 'f6',
        18: 'f7',
        19: 'f8',
        20: 'f9',
        21: 'f10',
        23: 'f11',
        24: 'f12',
      };
      const code = keyCodes[key];
      if (code !== undefined) events.push(keyEvent(code, mods));
      return;
    }
    case 't': {
      // xterm window-size report: CSI 8 ; rows ; columns t
      if (first !== 8 || values.length < 3) return;
      const rows = values[1];
      const columns = values[2];
      if (rows === undefined || columns === undefined || !Number.isFinite(rows) || !Number.isFinite(columns)) return;
      if (rows <= 0 || columns <= 0) return;
      events.push({ type: 'resize', columns: Math.trunc(columns), rows: Math.trunc(rows) });
      return;
    }
    default:
      return;
  }
}

/**
 * Incremental terminal input parser.
 *
 * Feed string or UTF-8 byte chunks to push(); complete events are returned
 * immediately. A trailing partial sequence stays buffered. Lone ESC is
 * ambiguous with the start of an escape sequence, so this parser never uses a
 * hidden timer: the app should call shouldFlush(now) after ESCAPE_TIMEOUT_MS
 * and then flushPending(), which emits the Escape key and discards the
 * unparsed prefix.
 *
 * Bracketed paste is collected until the closing marker and emitted as one
 * paste event, preserving newlines and raw pasted text.
 */
export class InputParser {
  private decoder = new TextDecoder('utf-8', { fatal: false });
  private buffer = '';
  private pasting = false;
  private pendingAt: number | null = null;

  /** Decode a chunk and return all complete events. */
  push(chunk: string | Uint8Array): InputEvent[] {
    if (typeof chunk === 'string') {
      if (chunk.length === 0) return [];
      this.buffer += chunk;
    } else if (chunk instanceof Uint8Array) {
      if (chunk.length === 0) return [];
      this.buffer += this.decoder.decode(chunk, { stream: true });
    } else {
      return [];
    }

    const events: InputEvent[] = [];
    this.drain(events);
    this.updatePending();
    return events;
  }

  /** Currently buffered, not-yet-emitted input. */
  get pending(): string {
    return this.buffer;
  }

  /** Timestamp when buffered input first became blocked, or null. */
  get pendingSince(): number | null {
    return this.pendingAt;
  }

  get isPasting(): boolean {
    return this.pasting;
  }

  /** True once buffered input has waited at least timeoutMs (default 50ms). */
  shouldFlush(now = Date.now(), timeoutMs = ESCAPE_TIMEOUT_MS): boolean {
    if (this.pasting || this.pendingAt === null || this.buffer.length === 0) return false;
    return now - this.pendingAt >= timeoutMs;
  }

  /**
   * Resolve a pending ESC prefix. Emits one Escape key and discards the rest
   * of the buffered, incomplete sequence. Ongoing bracketed paste is left
   * untouched because only its closing marker can end it.
   */
  flushPending(): InputEvent[] {
    if (this.pasting || this.buffer.length === 0) return [];
    const events: InputEvent[] = [];
    if (this.buffer.charCodeAt(0) === 0x1b) {
      events.push(keyEvent('escape'));
    }
    this.buffer = '';
    this.pendingAt = null;
    return events;
  }

  /** Drop all buffered input and start a fresh UTF-8 decoder. */
  reset(): void {
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    this.buffer = '';
    this.pasting = false;
    this.pendingAt = null;
  }

  private updatePending(): void {
    if (this.pasting || this.buffer.length === 0) {
      this.pendingAt = null;
    } else if (this.pendingAt === null) {
      this.pendingAt = Date.now();
    }
  }

  private drain(events: InputEvent[]): void {
    while (this.buffer.length > 0) {
      if (this.pasting) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end < 0) return;
        const text = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        this.pasting = false;
        events.push({ type: 'paste', text });
        continue;
      }

      if (this.buffer.charCodeAt(0) === 0x1b) {
        if (!this.consumeEscape(events)) return;
        continue;
      }

      const token = plainToken(this.buffer);
      if (token === undefined) {
        // Unknown C0 control: drop it safely.
        this.buffer = this.buffer.slice(1);
        continue;
      }
      this.buffer = this.buffer.slice(token.length);
      events.push(token.event);
    }
  }

  /** Consume one ESC-prefixed token. Returns false when more bytes are needed. */
  private consumeEscape(events: InputEvent[]): boolean {
    if (this.buffer.length === 1) return false;
    const next = this.buffer[1]!;

    if (next === '[') return this.consumeCsi(events);
    if (next === 'O') return this.consumeSs3(events);
    if (next === ']') return this.skipOsc();
    if (next === 'P' || next === 'X' || next === '^' || next === '_') return this.skipControlString();

    if (next === ESC) {
      // Two ESC bytes: the first is a bare Escape, the second may start its
      // own sequence (or be another bare Escape resolved later).
      events.push(keyEvent('escape'));
      this.buffer = this.buffer.slice(1);
      return true;
    }

    const token = plainToken(this.buffer.slice(1));
    if (token === undefined) {
      // Unknown token after ESC: drop ESC plus one byte, never throw.
      this.buffer = this.buffer.slice(2);
      return true;
    }

    const event = token.event;
    if (event.type === 'key') {
      event.mods.alt = true;
    }
    events.push(event);
    this.buffer = this.buffer.slice(1 + token.length);
    return true;
  }

  private consumeCsi(events: InputEvent[]): boolean {
    let index = 2;
    while (index < this.buffer.length) {
      const code = this.buffer.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        const params = this.buffer.slice(2, index);
        const final = this.buffer[index]!;
        this.buffer = this.buffer.slice(index + 1);

        if (final === '~' && params === '200') {
          this.pasting = true;
          return true;
        }
        if (final === '~' && params === '201') {
          return true;
        }
        if ((final === 'M' || final === 'm') && params.startsWith('<')) {
          const parts = params.slice(1).split(';');
          const rawButton = Number.parseInt(parts[0] ?? '', 10);
          if (rawButton === 64 || rawButton === 65) {
            events.push({ type: 'wheel', direction: rawButton === 64 ? 'up' : 'down' });
            return true;
          }
          const x = Number.parseInt(parts[1] ?? '', 10);
          const y = Number.parseInt(parts[2] ?? '', 10);
          if (!Number.isFinite(rawButton) || !Number.isFinite(x) || !Number.isFinite(y)) return true;
          const button = rawButton & 3;
          const motion = (rawButton & 32) !== 0;
          const action = final === 'm' || button === 3 ? 'release' : motion ? 'drag' : 'press';
          events.push({ type: 'mouse', action, button, x, y });
          return true;
        }
        keyFromCsi(final, params, events);
        return true;
      }
      if (code < 0x20 || code === 0x7f) {
        // Malformed CSI: drop ESC [ and let the control byte be parsed next.
        this.buffer = this.buffer.slice(2);
        return true;
      }
      index++;
    }
    return false;
  }

  private consumeSs3(events: InputEvent[]): boolean {
    if (this.buffer.length < 3) return false;
    const final = this.buffer[2]!;
    this.buffer = this.buffer.slice(3);
    switch (final) {
      case 'A':
        events.push(keyEvent('up'));
        return true;
      case 'B':
        events.push(keyEvent('down'));
        return true;
      case 'C':
        events.push(keyEvent('right'));
        return true;
      case 'D':
        events.push(keyEvent('left'));
        return true;
      case 'H':
        events.push(keyEvent('home'));
        return true;
      case 'F':
        events.push(keyEvent('end'));
        return true;
      case 'P':
        events.push(keyEvent('f1'));
        return true;
      case 'Q':
        events.push(keyEvent('f2'));
        return true;
      case 'R':
        events.push(keyEvent('f3'));
        return true;
      case 'S':
        events.push(keyEvent('f4'));
        return true;
      case 'M':
        events.push(keyEvent('enter'));
        return true;
      default:
        return true;
    }
  }

  private skipOsc(): boolean {
    let index = 2;
    while (index < this.buffer.length) {
      const code = this.buffer.charCodeAt(index);
      if (code === 0x07 || code === 0x9c) {
        this.buffer = this.buffer.slice(index + 1);
        return true;
      }
      if (code === 0x1b && this.buffer.charCodeAt(index + 1) === 0x5c) {
        this.buffer = this.buffer.slice(index + 2);
        return true;
      }
      index++;
    }
    return false;
  }

  private skipControlString(): boolean {
    let index = 2;
    while (index < this.buffer.length) {
      const code = this.buffer.charCodeAt(index);
      if (code === 0x9c) {
        this.buffer = this.buffer.slice(index + 1);
        return true;
      }
      if (code === 0x1b && this.buffer.charCodeAt(index + 1) === 0x5c) {
        this.buffer = this.buffer.slice(index + 2);
        return true;
      }
      index++;
    }
    return false;
  }
}