import type { MockScenario, MockStep, MockTool } from './types.js';

const call = (name: string, input: Record<string, unknown>, expect?: MockTool['expect']): MockStep => ({
  tools: [{ name, input, ...(expect === undefined ? {} : { expect }) }],
});
const done = (id: string): MockStep => ({ text: `MOCK PASS: ${id} (tool results checked).` });
const plan = (status: string): MockStep => call('UpdatePlan', { plan: [{ step: 'Verify mock workspace', status }] });

const files: MockScenario = {
  id: 'files', description: 'Plan → Write → parallel Read/ListDir/Glob/Grep → Edit → ApplyPatch → Shell → plan complete',
  steps: [
    plan('in_progress'),
    call('Read', { path: 'mock-output/hello.txt' }, {}),
    call('Write', { path: 'mock-output/hello.txt', content: 'hello mock\n' }),
    { tools: [
      { name: 'Read', input: { path: 'mock-output/hello.txt' }, expect: { isError: false, contains: 'hello mock' } },
      { name: 'ListDir', input: { path: 'mock-output' } },
      { name: 'Glob', input: { pattern: '**/*.txt', path: 'mock-output' } },
      { name: 'Grep', input: { pattern: 'hello', path: 'mock-output' } },
    ] },
    call('Edit', { path: 'mock-output/hello.txt', old_string: 'hello mock', new_string: 'hello codingx' }),
    call('Read', { path: 'mock-output/hello.txt' }),
    call('ApplyPatch', { patch: '--- a/mock-output/hello.txt\n+++ b/mock-output/hello.txt\n@@ -1 +1,2 @@\n hello codingx\n+verified\n' }),
    call('Shell', { command: "printf 'hello codingx\\nverified\\n' | diff - mock-output/hello.txt && printf 'MOCK_SHELL_OK\\n'" }, { isError: false, contains: 'MOCK_SHELL_OK' }),
    plan('completed'), done('files'),
  ],
};

function processScenario(pty: boolean): MockScenario {
  const id = pty ? 'pty' : 'process';
  return {
    id, description: `${pty ? 'PTY' : 'Pipe'} process start/list/write/read/stop with dynamic processId`,
    steps: [
      call('ProcessStart', { command: 'cat', stdin: true, ...(pty ? { pty: true, cols: 80, rows: 24 } : {}) }),
      call('ProcessList', {}),
      call('ProcessWrite', { process_id: '{{0.0.processId}}', text: 'mock-process-input\n' }),
      ...(pty ? [call('ProcessWrite', { process_id: '{{0.0.processId}}', cols: 100, rows: 30 })] : []),
      // EOF makes readiness observable: wait for cat to finish, rather than
      // assuming it has produced output after a fixed short sleep under load.
      call('ProcessWrite', { process_id: '{{0.0.processId}}', eof: true }),
      call('ProcessRead', { process_id: '{{0.0.processId}}', wait_ms: 5000 }, { isError: false, contains: 'mock-process-input' }),
      call('ProcessStop', { process_id: '{{0.0.processId}}' }), done(id),
    ],
  };
}

const http = (id: string, status: number, type: string, message: string, attempts?: number): MockScenario => ({
  id, description: `HTTP ${status}${attempts ? ` × ${attempts}, then success` : ' permanent failure'}`,
  httpError: { status, type, message, ...(attempts === undefined ? {} : { attempts }) },
  steps: [{ text: `MOCK PASS: ${id} recovered.` }],
});

export const builtinScenarios: MockScenario[] = [
  { id: 'text', description: 'Chinese/emoji Markdown streaming, usage and prompt cache counters', steps: [{
    text: '# Mock LLM ready\n\n中文流式输出 🧪\n\n- **bold** and `inline code`\n- [local docs](docs/mock-llm.md)\n\n```ts\nconst answer = 42;\n```\n\n| Feature | Result |\n| --- | --- |\n| SSE | ready |\n\nMOCK PASS: text',
  }] },
  files, processScenario(false), processScenario(true),
  { id: 'ask', description: 'Interactive single/multi/free-text questions; exec returns is_error', steps: [
    call('AskUserQuestion', { questions: [
      { id: 'color', header: 'Color', question: '选择一种颜色', options: [{ label: 'Blue' }, { label: 'Green' }] },
      { id: 'checks', question: '选择检查项', multi_select: true, options: [{ label: 'Types' }, { label: 'Tests' }] },
      { id: 'notes', question: '补充说明' },
    ] }, {}), done('ask'),
  ] },
  { id: 'skill', description: 'Load mock-check skill created by --init', steps: [
    call('Skill', { name: 'mock-check' }, { isError: false, contains: 'MOCK_SKILL_READY' }), done('skill'),
  ] },
  { id: 'errors', description: 'Missing file, invalid tool input, disabled/private WebFetch and unknown tool', steps: [
    call('Read', { path: 'mock-missing-file.txt' }, { isError: true }),
    call('Read', { path: 42 }, { isError: true }),
    call('WebFetch', { url: 'https://127.0.0.1/mock' }, { isError: true }),
    call('MockUnknownTool', {}, { isError: true }), done('errors'),
  ] },
  { id: 'permission', description: 'Run with --sandbox read-only: a write must be rejected', steps: [
    call('Write', { path: 'mock-denied.txt', content: 'must not be written\n' }, { isError: true }), done('permission'),
  ] },
  { id: 'approval', description: 'Explicit escalation prompt (interactive); exec must fail closed', steps: [
    call('Shell', { command: "printf 'mock-approved\\n'", sandbox_permissions: 'require_escalated', justification: 'Verify the mock approval panel.', additional_permissions: { filesystem: { read: ['.'] } } }, {}), done('approval'),
  ] },
  { id: 'shell-errors', description: 'Nonzero exit, timeout, then successful recovery', steps: [
    call('Shell', { command: "printf 'mock-stderr\\n' >&2; exit 7" }, { isError: true, contains: 'mock-stderr' }),
    call('Shell', { command: 'sleep 2', timeout_ms: 100 }, { isError: true }),
    call('Shell', { command: "printf 'mock-recovered\\n'" }, { isError: false, contains: 'mock-recovered' }), done('shell-errors'),
  ] },
  { id: 'conflict', description: 'External Shell mutation after Read; stale Edit must fail', steps: [
    call('Read', { path: 'mock-conflict.txt' }, {}),
    call('Write', { path: 'mock-conflict.txt', content: 'before\n' }),
    call('Read', { path: 'mock-conflict.txt' }),
    call('Shell', { command: "printf 'external\\n' > mock-conflict.txt" }),
    call('Edit', { path: 'mock-conflict.txt', old_string: 'before', new_string: 'after' }, { isError: true }), done('conflict'),
  ] },
  { id: 'loop', description: 'Repeat ListDir until max_steps or user abort (no PASS expected)', repeat: true, steps: [call('ListDir', { path: '.' })] },
  { id: 'image', description: 'Require an image block; validates attachment transport, not vision', requireImage: true, steps: [{ text: 'MOCK PASS: image received.' }] },
  { id: 'context', description: 'Large text for repeated turns and context compaction', steps: [{ text: 'Mock context paragraph 中文.\n'.repeat(1600) }] },
  { id: 'slow', description: 'Wait 10 seconds before streaming; useful for cancellation', steps: [{ text: 'MOCK PASS: slow', delayMs: 10_000 }] },
  { id: 'max-tokens', description: 'A complete stream with stop_reason=max_tokens', steps: [{ text: 'Output token limit reached.', stop: 'max_tokens' }] },
  { id: 'refusal', description: 'A complete refusal stream', steps: [{ text: 'Mock refusal.', stop: 'refusal' }] },
  ...(['stream-error', 'disconnect', 'malformed-json'] as const).map((fault): MockScenario => ({
    id: fault, description: `Partial text followed by ${fault}; must not retry after content`, steps: [{ text: 'Partial mock output.', fault }],
  })),
  http('retry', 503, 'overloaded_error', 'Mock temporarily unavailable.', 2),
  http('rate-limit', 429, 'rate_limit_error', 'Mock rate limited.', 1),
  http('auth', 401, 'authentication_error', 'Mock authentication failure.'),
  http('overflow', 400, 'invalid_request_error', 'prompt is too long: context length exceeded'),
];
