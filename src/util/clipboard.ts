import { spawn } from 'node:child_process';

export interface CopyToClipboardOptions {
  write: (chunk: string) => void;
  /** Injection point for tests; defaults to a platform clipboard command. */
  runNative?: (command: string, args: readonly string[], text: string) => Promise<boolean>;
}

const NATIVE_CLIPBOARD: Record<string, Array<{ command: string; args: string[] }>> = {
  darwin: [{ command: 'pbcopy', args: [] }],
  win32: [{ command: 'clip', args: [] }],
  linux: [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ],
};

function runNative(command: string, args: readonly string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let child;
    try {
      child = spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      finish(false);
      return;
    }
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
    child.stdin.on('error', () => undefined);
    child.stdin.end(text);
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2_000);
    timer.unref?.();
  });
}

/**
 * Put text on the clipboard. OSC 52 is written first (works over SSH), then a
 * native clipboard command is attempted because some terminals ignore OSC 52.
 */
export async function copyTextToClipboard(text: string, options: CopyToClipboardOptions): Promise<string> {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  try {
    options.write('\x1b]52;c;' + encoded + '\x07');
  } catch {
    // Native clipboard can still succeed.
  }
  const candidates = NATIVE_CLIPBOARD[process.platform] ?? [];
  for (const candidate of candidates) {
    const run = options.runNative ?? runNative;
    if (await run(candidate.command, candidate.args, text)) {
      return 'OSC52 + ' + candidate.command;
    }
  }
  return 'OSC52';
}
