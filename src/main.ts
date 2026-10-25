import { runCli } from './cli/index.js';
import { VERSION } from './version.js';

export { VERSION };

/** CLI entry point; bin/codingx.js forwards argv and applies the exit code. */
export async function main(argv: string[]): Promise<number> {
  return runCli(argv);
}
