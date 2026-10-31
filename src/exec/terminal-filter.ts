/** Stateful VT filtering: escape sequences can span arbitrary PTY chunks. */
export class TerminalFilter {
  private state: 'text' | 'escape' | 'csi' | 'string' | 'stringEscape' = 'text';
  push(input: string): string {
    let out = '';
    for (const c of input) {
      const n = c.charCodeAt(0);
      if (this.state === 'stringEscape') { this.state = c === '\\' ? 'text' : 'string'; continue; }
      if (this.state === 'string') { if (c === '\x07' || c === '\x9c') this.state = 'text'; else if (c === '\x1b') this.state = 'stringEscape'; continue; }
      if (this.state === 'csi') { if (n >= 0x40 && n <= 0x7e) this.state = 'text'; continue; }
      if (this.state === 'escape') { this.state = c === '[' ? 'csi' : ']PX^_'.includes(c) ? 'string' : 'text'; continue; }
      if (c === '\x1b') { this.state = 'escape'; continue; }
      if (c === '\x9b') { this.state = 'csi'; continue; }
      if (c === '\x9d' || c === '\x90') { this.state = 'string'; continue; }
      if (c === '\n' || c === '\t' || n >= 32 && !(n >= 0x7f && n <= 0x9f)) out += c;
    }
    return out;
  }
}
