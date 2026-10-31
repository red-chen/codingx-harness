import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeStatusBarPlugin, loadStatusBarPlugin, parseStatusBarView, StatusBarPluginHost } from '../src/plugins/status-bar.js';
import type { PluginManifest, StatusBarInput, StatusBarView } from '../src/plugins/types.js';
import { loadConfig } from '../src/config/load.js';
import { recordUsageStream, restoreRequestUsage, type RequestUsage } from '../src/providers/usage.js';
import { EMPTY_USAGE, type ModelClient } from '../src/providers/types.js';
import { CellBuffer } from '../src/tui/terminal/buffer.js';
import { renderStatusRow } from '../src/tui/widgets/status.js';
import { createTuiAppForSession, totalUsageFrom } from '../src/cli/commands/tui.js';
import type { SessionHandle } from '../src/session/types.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'codingx-plugin-')); });
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

function record(overrides: Partial<RequestUsage> = {}): RequestUsage {
  return { requestId: 'request-1', turnId: 'turn-1', model: 'deepseek-flash', provider: 'custom-provider-id',
    origin: 'https://api.deepseek.com', startedAt: '2026-11-02T02:00:00.000Z', purpose: 'turn',
    complete: true, cacheBreakdownKnown: true,
    usage: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000, cacheCreationTokens: 0 }, ...overrides };
}
function input(): StatusBarInput {
  return { version: 1, sessionId: 'session-1', generation: 0, cwd: root, width: 120,
    current: { provider: 'custom-provider-id', model: 'deepseek-flash', origin: 'https://api.deepseek.com' },
    status: { state: 'idle', elapsedMs: 0, turnNumber: 1, step: 1 },
    context: { usedTokens: 0, windowTokens: 1000000 }, totalUsage: { ...EMPTY_USAGE },
    usageRecords: [record()], usageIncomplete: false };
}
const manifest: PluginManifest = { manifest_version: 1, id: 'test-plugin', name: 'test', version: '1.0.0',
  capabilities: { status_bar: { protocol: 'codingx.status-bar/v1', mode: 'decorate',
    placement: { after: 'total_tokens' }, execution: { type: 'command', command: 'node', args: ['./index.mjs'] } } } };

async function plugin(source: string) {
  await writeFile(path.join(root, 'index.mjs'), source);
  return { manifest, directory: root, timeoutMs: 150, input: input(), env: process.env };
}

describe('plugin loading and execution', () => {
  it('enables only the global plugin and rejects traversal IDs', async () => {
    const home = path.join(root, 'home');
    await mkdir(home);
    await mkdir(path.join(root, '.codingx'));
    await writeFile(path.join(home, 'config.toml'), '[status_bar]\nplugin = "deepseek-cost"\n');
    await writeFile(path.join(root, '.codingx/config.toml'), '[status_bar]\nplugin = "evil"\n');
    const loaded = await loadConfig({ cwd: root, codingxHome: home, env: {} });
    expect(loaded.config.statusBar).toEqual({ plugin: 'deepseek-cost', timeoutMs: 1000, refreshMs: 1000 });
    expect(loaded.warnings.join()).toContain('status_bar');
    await expect(loadStatusBarPlugin(home, '../evil')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('recognizes YAML and rejects unknown versions without executing anything', async () => {
    const directory = path.join(root, 'plugins', 'deepseek-cost');
    await mkdir(directory, { recursive: true });
    const yaml = await readFile('plugins/deepseek-cost/manifest.yaml', 'utf8');
    await writeFile(path.join(directory, 'manifest.yaml'), yaml);
    expect((await loadStatusBarPlugin(root, 'deepseek-cost')).manifest.id).toBe('deepseek-cost');
    await writeFile(path.join(directory, 'manifest.yaml'), yaml.replace('status-bar/v1', 'status-bar/v2'));
    await expect(loadStatusBarPlugin(root, 'deepseek-cost')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await writeFile(path.join(directory, 'manifest.yaml'), yaml + '\nid: duplicate\n');
    await expect(loadStatusBarPlugin(root, 'deepseek-cost')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('passes JSON on stdin, uses plugin cwd, and strips credentials from the environment', async () => {
    const options = await plugin(`let text=''; for await (const c of process.stdin) text+=c;
      const input=JSON.parse(text);
      console.log(JSON.stringify({version:1,segments:[{text:JSON.stringify({model:input.current.model,
        cwd:process.cwd(),key:process.env.API_KEY,custom:process.env.WEIRD_CREDENTIAL_NAME})}]}));`);
    const result = await executeStatusBarPlugin({ ...options, timeoutMs: 2000,
      env: { ...process.env, API_KEY: 'secret-key', WEIRD_CREDENTIAL_NAME: 'secret-custom' } });
    expect(result.segments[0]?.text).toContain('deepseek-flash');
    expect(result.segments[0]?.text).toContain(root);
    expect(result.segments[0]?.text).not.toContain('secret');
  });

  it.each([
    'setInterval(()=>{},1000)',
    'console.log("invalid json")',
    'console.log(JSON.stringify({version:2,segments:[]}))',
    'process.exit(3)',
    'console.log("x".repeat(40000))',
  ])('fails safely for timeout, invalid and oversized output (%s)', async (source) => {
    await expect(executeStatusBarPlugin(await plugin(source))).rejects.toMatchObject({ code: 'PLUGIN_ERROR' });
  });

  it('filters terminal escapes and validates styles', () => {
    const parsed = parseStatusBarView({ version: 1, segments: [{ text: '\x1b[31m中文\n💰\x1b[0m', fg: '#aabbcc' }] });
    expect(parsed.segments[0]?.text).toBe('中文 💰');
    expect(() => parseStatusBarView({ version: 1, segments: [{ text: 'x', fg: 'red' }] })).toThrow();
  });

  it('reaps background descendants even when the plugin exits successfully', async () => {
    const options = await plugin(`import {spawn} from 'node:child_process';
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      child.unref(); console.log(JSON.stringify({version:1,segments:[{text:String(child.pid)}]}));`);
    const view = await executeStatusBarPlugin({ ...options, timeoutMs: 2000 });
    const pid = Number(view.segments[0]?.text);
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000, interval: 20 });
  });

  it('does not block or overlap, rejects stale results after clear/model switch, and aborts on close', async () => {
    let current = input();
    let resolve: (view: StatusBarView) => void = () => {};
    let signal: AbortSignal | undefined;
    const execute = vi.fn((options) => { signal = options.signal; return new Promise<StatusBarView>((done) => { resolve = done; }); });
    const publish = vi.fn();
    const host = new StatusBarPluginHost({ manifest, directory: root, timeoutMs: 1000, refreshMs: 1000,
      env: {}, snapshot: () => current, publish, warn: vi.fn(), execute });
    host.poll(); host.poll();
    expect(execute).toHaveBeenCalledTimes(1);
    current = { ...current, generation: 1, current: { ...current.current, model: 'deepseek-v4-pro' } };
    host.poll();
    resolve({ version: 1, segments: [{ text: 'stale' }] });
    await new Promise((done) => setImmediate(done));
    expect(publish.mock.calls.some(([segments]) => segments.some((s: { text: string }) => s.text === 'stale'))).toBe(false);
    // A fresh host close must cancel a running execution and suppress its response.
    const host2 = new StatusBarPluginHost({ manifest, directory: root, timeoutMs: 1000, refreshMs: 1000,
      env: {}, snapshot: () => current, publish, warn: vi.fn(), execute });
    host2.poll();
    const closed = host2.close();
    expect(signal?.aborted).toBe(true);
    resolve({ version: 1, segments: [{ text: 'closed' }] });
    await closed; await host.close();
  });
});

describe('request usage and display', () => {
  it('restores token totals from aborted as well as completed turns', () => {
    expect(totalUsageFrom([
      { type: 'turn.end', usage: { ...EMPTY_USAGE, inputTokens: 10 } },
      { type: 'turn.aborted', usage: { ...EMPTY_USAGE, outputTokens: 5 } },
    ])).toEqual({ ...EMPTY_USAGE, inputTokens: 10, outputTokens: 5 });
  });
  it('records attributed usage once through SessionStore, and restores without duplication', async () => {
    const append = vi.fn().mockResolvedValue([]);
    const client: ModelClient = { countTokens: async () => 0, async *stream() {
      yield { type: 'usage', inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 };
      yield { type: 'stop', reason: 'end_turn' };
    } };
    const emitted: RequestUsage[] = [];
    for await (const _ of recordUsageStream({ client, session: { append } as unknown as SessionHandle,
      request: { model: 'deepseek-flash', system: '', messages: [], tools: [], maxOutputTokens: 10 },
      turnId: 't', provider: 'p', origin: 'https://api.deepseek.com', purpose: 'compaction', emit: (r) => emitted.push(r) })) { /* consume */ }
    expect(append).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({ provider: 'p', purpose: 'compaction', complete: true, cacheBreakdownKnown: true,
      usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: 2 } });
    expect(restoreRequestUsage([append.mock.calls[0]![0], append.mock.calls[0]![0]])).toHaveLength(1);
  });

  it('records missing usage as incomplete on stream failure', async () => {
    const append = vi.fn().mockResolvedValue([]);
    const client: ModelClient = { countTokens: async () => 0, async *stream() { throw new Error('broken'); } };
    await expect((async () => {
      for await (const _ of recordUsageStream({ client, session: { append } as unknown as SessionHandle,
        request: { model: 'deepseek-flash', system: '', messages: [], tools: [], maxOutputTokens: 10 },
        turnId: 't', provider: 'p', purpose: 'turn', emit: () => {} })) { /* consume */ }
    })()).rejects.toThrow('broken');
    expect(append.mock.calls[0]?.[0].record.complete).toBe(false);
  });

  it('restores request records into TUI, deduplicates updates, and clears them', () => {
    const r = record();
    const app = createTuiAppForSession({ sessionId: 's', cwd: root, model: 'deepseek-flash',
      permissionProfile: ':workspace', approvalPolicy: 'never', contextWindow: 1000000, version: 'test',
      width: 120, height: 24, resumed: { requestUsage: [r], usageIncomplete: true } });
    app.handleEvent({ type: 'usage.recorded', record: r });
    expect(app.state.requestUsage).toHaveLength(1);
    expect(app.state.usageIncomplete).toBe(true);
    app.setStatusBarSegments([{ text: 'amount' }]);
    app.resetSession();
    expect(app.state.requestUsage).toEqual([]);
    expect(app.state.statusBarSegments).toBeUndefined();
    expect(app.state.usageIncomplete).toBe(false);
  });

  it('appends styled CJK text after tok and drops the decoration first on narrow screens', () => {
    for (const width of [120, 40, 20]) {
      const frame = new CellBuffer(width, 1);
      renderStatusRow({ x: 0, y: 0, width, height: 1 }, frame, {
        status: { state: 'awaiting', elapsedMs: 0 }, awaitingKind: 'approval',
        usage: EMPTY_USAGE, totalUsage: EMPTY_USAGE, contextUsedTokens: 0, contextWindowTokens: 1000000,
        segments: [{ text: ' · 费用≈¥0.1842 💰', fg: '#a5d6a7', bold: true }],
      });
      const row = Array.from({ length: width }, (_, x) => frame.get(x, 0)?.symbol ?? '').join('');
      expect(row).toContain(width < 40 ? 'Approval' : 'Awaiting approval');
      if (width === 120) expect(row).toContain('tok 0 · 费用≈¥0.1842 💰');
      else expect(row).not.toContain('费用');
    }
  });
});

describe('bundled DeepSeek plugin', () => {
  const costUrl = new URL('../plugins/deepseek-cost/cost.mjs', import.meta.url).href;
  const updateUrl = new URL('../plugins/deepseek-cost/update-prices.mjs', import.meta.url).href;
  async function pricing() { return JSON.parse(await readFile('plugins/deepseek-cost/pricing.json', 'utf8')); }

  it('calculates cache hit/miss/output separately, per request model and period, without double counting', async () => {
    const { calculateCost } = await import(costUrl);
    const context = input();
    const offPeak = record({ requestId: 'second', startedAt: '2026-10-31T02:00:00.000Z', model: 'deepseek-v4-pro' });
    context.usageRecords = [record(), offPeak, offPeak];
    // Flash peak 10.04 + Pro weekend 18.15 = 28.19.
    expect(calculateCost(context, await pricing()).segments[0].text).toBe(' · ≈¥28.1900');
    context.current.model = 'deepseek-v4-pro';
    expect(calculateCost(context, await pricing()).segments[0].text).toBe(' · ≈¥28.1900');
  });

  it('handles Beijing boundaries, holidays, weekends and unknown calendars', async () => {
    const { pricePeriod } = await import(costUrl);
    const { calendar } = await pricing();
    expect(pricePeriod('2026-11-02T00:59:59Z', calendar)).toBe('offPeak');
    expect(pricePeriod('2026-11-02T01:00:00Z', calendar)).toBe('peak');
    expect(pricePeriod('2026-11-02T04:00:00Z', calendar)).toBe('offPeak');
    expect(pricePeriod('2026-11-02T06:00:00Z', calendar)).toBe('peak');
    expect(pricePeriod('2026-11-02T10:00:00Z', calendar)).toBe('offPeak');
    expect(pricePeriod('2026-10-01T02:00:00Z', calendar)).toBe('offPeak');
    expect(pricePeriod('2026-10-10T02:00:00Z', calendar)).toBe('offPeak');
    expect(pricePeriod('2027-01-04T02:00:00Z', calendar)).toBeUndefined();
  });

  it('does not apply official prices to proxies or present missing data as zero', async () => {
    const { calculateCost } = await import(costUrl);
    const context = input();
    context.current.origin = 'https://proxy.example';
    expect(calculateCost(context, await pricing()).segments).toEqual([]);
    context.current.origin = 'https://api.deepseek.com';
    context.usageRecords = [record({ cacheBreakdownKnown: false })];
    expect(calculateCost(context, await pricing()).segments).toEqual([]);
    context.usageRecords = [record({ complete: false })];
    expect(calculateCost(context, await pricing()).segments).toEqual([]);
    context.usageRecords = [record({ startedAt: '2025-01-01T00:00:00Z' })];
    expect(calculateCost(context, await pricing()).segments).toEqual([]);
    context.usageRecords = [record(), record({ requestId: 'unknown', complete: false })];
    expect(calculateCost(context, await pricing()).segments[0].text).toBe(' · DS ≈¥10.0400');
  });

  it('keeps historical requests priced using their original snapshot', async () => {
    const { calculateCost } = await import(costUrl);
    const data = await pricing();
    const before = calculateCost(input(), data);
    data.snapshots.push({ ...data.snapshots[0], effectiveFrom: '2026-11-03T00:00:00Z', models: {} });
    expect(calculateCost(input(), data)).toEqual(before);
  });

  it('parses only the expected official table and rejects incompatible page changes offline', async () => {
    const { parseOfficialPrices } = await import(updateUrl);
    const html = '<table>deepseek-flash deepseek-v4-pro 缓存命中 缓存未命中 ' +
      [0.02, 0.15, 0.04, 0.3, 1, 4.5, 2, 9, 4, 13.5, 8, 27].map((n) => '<td>' + n + '元</td>').join('') +
      '</table>周一至周五 法定节假日 9:00 - 12:00 14:00 - 18:00';
    expect(parseOfficialPrices(html)).toEqual((await pricing()).snapshots[0].models);
    expect(() => parseOfficialPrices(html.replace('9:00', '8:00'))).toThrow();
    expect(() => parseOfficialPrices('<table>changed</table>')).toThrow();
  });

  it('runs the shipped plugin via the real subprocess protocol', async () => {
    const directory = path.resolve('plugins/deepseek-cost');
    const result = await executeStatusBarPlugin({ manifest: { ...manifest, id: 'deepseek-cost' },
      directory, input: input(), timeoutMs: 2000, env: process.env });
    expect(result.segments[0]?.text).toBe(' · ≈¥10.0400');
  });
});
