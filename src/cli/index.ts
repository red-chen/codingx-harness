import { Command, CommanderError } from 'commander';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, describeError } from '../util/errors.js';
import { VERSION } from '../version.js';
import type { TextSink } from '../ui/plain.js';
import { runExec } from './commands/exec.js';
import { runInteractive } from './commands/interactive.js';
import { runLog } from './commands/log.js';
import { runSessionsCommand } from './commands/sessions.js';
import { runDaemonProcess, runSessiondCommand } from './commands/sessiond.js';

export interface CliIo {
  stdin: NodeJS.ReadableStream;
  stdout: TextSink;
  stderr: TextSink;
  env: NodeJS.ProcessEnv;
}

async function resolveCwd(input: string | undefined): Promise<string> {
  const cwd = input ? path.resolve(input) : process.cwd();
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new ConfigError('Working directory is not a directory: ' + cwd);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('Working directory does not exist or is not accessible: ' + cwd, { cause: error });
  }
  return cwd;
}

/** Commander collector for repeatable --add-dir values. */
function collectDir(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** Parse argv and execute one command. Returns the process exit code. */
export async function runCli(argv: string[], io: Partial<CliIo> = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;

  let exitCode = 0;
  const program = new Command();
  program
    .name('codingx')
    .description('Terminal AI coding agent')
    .version(VERSION, '-V, --version')
    .option('-C, --cd <path>', 'run as if started in this directory')
    .option(
      '--add-dir <dir>',
      'additional directories that should be writable alongside the primary workspace (repeatable)',
      collectDir,
    )
    .option('--route <name>', 'select a configured provider route')
    .option('-m, --model <name>', 'override the target model')
    .option('-p, --provider <id>', 'pin a provider inside the selected route')
    .option('--json', 'emit machine-readable JSON Lines on stdout')
    .option('--plain', 'line-oriented plain text output')
    .option('--tui', 'force the full-screen TUI when stdin/stdout are TTYs')
    .option('-c, --continue', 'continue the most recent idle/interrupted session for this cwd')
    .option('--resume <id>', 'resume a session by id or unique prefix')
    .option('--fork <id>', 'fork a session and continue in the new session')
    .argument('[prompt...]', 'initial prompt for interactive mode')
    .action(async (promptParts: string[] | undefined) => {
      const options = program.opts();
      const resumeModes = [Boolean(options.continue), Boolean(options.resume), Boolean(options.fork)].filter(
        Boolean,
      ).length;
      if (resumeModes > 1) throw new ConfigError('Use only one of --continue, --resume or --fork.');
      const cwd = await resolveCwd(options.cd as string | undefined);
      const addDirs = (options.addDir as string[] | undefined) ?? [];
      const initialPrompt = promptParts?.join(' ');
      exitCode = await runInteractive({
        cwd,
        ...(addDirs.length > 0 ? { addDirs } : {}),
        ...(initialPrompt ? { initialPrompt } : {}),
        json: Boolean(options.json),
        ...(options.continue ? { continueSession: true } : {}),
        ...(options.resume ? { resumeSessionId: options.resume as string } : {}),
        ...(options.fork ? { forkSessionId: options.fork as string } : {}),
        ...(options.tui ? { tui: true } : {}),
        ...(options.plain ? { plain: true } : {}),
        ...(options.route ? { route: options.route as string } : {}),
        ...(options.model ? { model: options.model as string } : {}),
        ...(options.provider ? { provider: options.provider as string } : {}),
        env,
        ...(io.stdin ? { stdin: io.stdin } : {}),
        stdout,
        stderr,
      });
    })
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        stdout.write(text);
      },
      writeErr: (text) => {
        stderr.write(text);
      },
    });

  program
    .command('exec')
    .description('run one non-interactive turn')
    .argument('<prompt...>', 'task for the agent')
    .action(async (promptParts: string[]) => {
      const options = program.opts();
      if (options.continue || options.resume || options.fork) {
        throw new ConfigError('--continue, --resume and --fork are only supported in interactive mode.');
      }
      const cwd = await resolveCwd(options.cd as string | undefined);
      const addDirs = (options.addDir as string[] | undefined) ?? [];
      exitCode = await runExec({
        prompt: promptParts.join(' '),
        cwd,
        ...(addDirs.length > 0 ? { addDirs } : {}),
        json: Boolean(options.json),
        ...(options.route ? { route: options.route as string } : {}),
        ...(options.model ? { model: options.model as string } : {}),
        ...(options.provider ? { provider: options.provider as string } : {}),
        env,
        stdout,
        stderr,
      });
    });

  program
    .command('log')
    .description('replay a session rollout from JSONL')
    .requiredOption('--session <id>', 'session id or unique prefix')
    .action(async (commandOptions: { session: string }) => {
      const options = program.opts();
      const cwd = await resolveCwd(options.cd as string | undefined);
      exitCode = await runLog({
        sessionId: commandOptions.session,
        cwd,
        json: Boolean(options.json),
        env,
        stdout,
        stderr,
      });
    });

  const sessions = program
    .command('sessions')
    .description('inspect sessions managed by sessiond');

  sessions
    .command('list')
    .description('list sessions')
    .option('--limit <n>', 'maximum sessions to show', '20')
    .option('--status <status>', 'filter by session status')
    .action(async (commandOptions: { limit: string; status?: string }) => {
      const options = program.opts();
      const cwd = await resolveCwd(options.cd as string | undefined);
      exitCode = await runSessionsCommand({
        action: 'list',
        cwd,
        limit: Number.parseInt(commandOptions.limit, 10) || 20,
        ...(commandOptions.status ? { status: commandOptions.status } : {}),
        json: Boolean(options.json),
        env,
        stdout,
        stderr,
      });
    });

  sessions
    .command('show')
    .description('show one session and its rollout')
    .argument('<id>', 'session id or unique prefix')
    .option('--limit <n>', 'maximum rollout events to show')
    .action(async (id: string, commandOptions: { limit?: string }) => {
      const options = program.opts();
      const cwd = await resolveCwd(options.cd as string | undefined);
      exitCode = await runSessionsCommand({
        action: 'show',
        sessionId: id,
        cwd,
        ...(commandOptions.limit ? { limit: Number.parseInt(commandOptions.limit, 10) } : {}),
        json: Boolean(options.json),
        env,
        stdout,
        stderr,
      });
    });

  sessions
    .command('prune')
    .description('delete ended sessions older than a cutoff')
    .option('--older-than <days>', 'retention in days', '30')
    .option('--dry-run', 'list candidates without deleting')
    .action(async (commandOptions: { olderThan: string; dryRun?: boolean }) => {
      const options = program.opts();
      const cwd = await resolveCwd(options.cd as string | undefined);
      exitCode = await runSessionsCommand({
        action: 'prune',
        cwd,
        olderThanDays: Number.isFinite(Number.parseInt(commandOptions.olderThan, 10))
          ? Number.parseInt(commandOptions.olderThan, 10)
          : 30,
        ...(commandOptions.dryRun ? { dryRun: true } : {}),
        json: Boolean(options.json),
        env,
        stdout,
        stderr,
      });
    });

  sessions
    .command('watch')
    .description('stream session events until Ctrl+C')
    .argument('<id>', 'session id or unique prefix')
    .option('--from <seq>', 'start after this sequence number')
    .action(async (id: string, commandOptions: { from?: string }) => {
      const options = program.opts();
      const cwd = await resolveCwd(options.cd as string | undefined);
      exitCode = await runSessionsCommand({
        action: 'watch',
        sessionId: id,
        cwd,
        ...(commandOptions.from ? { fromSeq: Number.parseInt(commandOptions.from, 10) } : {}),
        json: Boolean(options.json),
        env,
        stdout,
        stderr,
      });
    });

  const sessiond = program
    .command('sessiond')
    .description('manage the local session daemon');

  for (const action of ['start', 'stop', 'status', 'restart'] as const) {
    sessiond
      .command(action)
      .description(action + ' the local sessiond')
      .action(async () => {
        const options = program.opts();
        const cwd = await resolveCwd(options.cd as string | undefined);
        exitCode = await runSessiondCommand({
          action,
          cwd,
          json: Boolean(options.json),
          env,
          stdout,
          stderr,
        });
      });
  }

  sessiond
    .command('__daemon', { hidden: true })
    .description('internal: run sessiond in the foreground')
    .requiredOption('--socket <path>', 'Unix socket path')
    .requiredOption('--sessions <dir>', 'session directory')
    .option('--idle-timeout <seconds>', 'idle timeout in seconds', '1800')
    .action(
      async (commandOptions: { socket: string; sessions: string; idleTimeout: string }) => {
        exitCode = await runDaemonProcess({
          socketPath: commandOptions.socket,
          sessionDir: commandOptions.sessions,
          idleTimeoutSeconds: Number.parseInt(commandOptions.idleTimeout, 10) || 1800,
          version: VERSION,
        });
      },
    );

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0 || error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
        return 0;
      }
      return 2;
    }
    const summary = describeError(error);
    stderr.write('codingx: ' + summary.message + '\n');
    if (env.CODINGX_LOG === 'debug' && error instanceof Error && error.stack) {
      stderr.write(error.stack + '\n');
    }
    return summary.exitCode;
  }
}