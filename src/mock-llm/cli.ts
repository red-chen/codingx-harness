import { readFile } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { CodingxError, describeError } from '../util/errors.js';
import { builtinScenarios } from './scenarios.js';
import { startMockServer } from './server.js';
import { createMockPlayground } from './playground.js';
import { mockScenarioSchema } from './types.js';

function number(min: number, max: number): (value: string) => number {
  return value => {
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new InvalidArgumentError(`Expected an integer between ${min} and ${max}.`);
    }
    return parsed;
  };
}

const program = new Command()
  .name('codingx-mock-llm')
  .description('Local Anthropic Messages/SSE fixtures for codingx; never calls an upstream LLM.')
  .option('--port <port>', 'Loopback port (0 chooses a free port)', number(0, 65535), 4010)
  .option('--scenario <id>', 'Default scenario for models without mock- prefix', 'text')
  .option('--scenario-file <path>', 'Additional JSON scenario or array of scenarios')
  .option('--chunk-bytes <bytes>', 'Maximum bytes per socket write', number(1, 1_048_576), 1024)
  .option('--delay-ms <ms>', 'Delay between socket writes', number(0, 60_000), 0)
  .option('--crlf', 'Use CRLF SSE framing')
  .option('--init <directory>', 'Create a new isolated home/workspace with config, skill and image fixtures')
  .option('--list', 'List built-in and custom scenarios, then exit')
  .parse();

const options = program.opts<{
  port: number; scenario: string; scenarioFile?: string; chunkBytes: number;
  delayMs: number; crlf?: boolean; init?: string; list?: boolean;
}>();

try {
  const raw: unknown = options.scenarioFile ? JSON.parse(await readFile(options.scenarioFile, 'utf8')) : [];
  const scenarios = (Array.isArray(raw) ? raw : [raw]).map(value => {
    const parsed = mockScenarioSchema.safeParse(value);
    if (!parsed.success) throw new CodingxError('CONFIG_ERROR', 'Invalid mock scenario: ' + parsed.error.message);
    return parsed.data;
  });
  if (options.list) {
    for (const scenario of [...builtinScenarios, ...scenarios]) console.log(`${scenario.id.padEnd(18)} ${scenario.description}`);
  } else {
    const server = await startMockServer({ ...options, scenarios });
    try {
      const playground = options.init ? await createMockPlayground(options.init, server.url) : undefined;
      console.log(JSON.stringify({ event: 'mock.ready', endpoint: server.url, scenarios: [...builtinScenarios, ...scenarios].map(s => s.id), ...(playground ? { playground } : {}) }));
      console.error('Mock LLM listening on ' + server.url + '; Ctrl+C to stop.');
      if (playground) {
        const quote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'";
        console.error(`\nIn another terminal:\nexport CODINGX_HOME=${quote(playground.home)}\nexport MOCK_LLM_API_KEY=mock-local-only\nnode bin/codingx.js -C ${quote(playground.workspace)} exec '[mock:files]'\nnode bin/codingx.js -C ${quote(playground.workspace)} --tui\n\nIn the TUI send [mock:text], [mock:ask], [mock:process], etc.\nDocumentation: docs/mock-llm.md`);
      }
      const shutdown = (): void => { void server.close().catch(() => { process.exitCode = 1; }); };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    } catch (cause) {
      await server.close();
      throw cause;
    }
  }
} catch (cause) {
  const failure = describeError(cause);
  console.error(failure.code + ': ' + failure.message);
  process.exitCode = 1;
}
