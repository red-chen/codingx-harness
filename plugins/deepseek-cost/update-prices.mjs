import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

/** Fail closed when the official table layout/models/schedule change. Never invent missing rates. */
export function parseOfficialPrices(html) {
  const table = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0];
  const text = table?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const document = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (!text || !/deepseek-flash.*deepseek-v4-pro/.test(text) ||
      !text.includes('缓存命中') || !text.includes('缓存未命中') ||
      !document.includes('周一至周五') || !document.includes('法定节假日') ||
      !/9:00\s*-\s*12:00/.test(document) || !/14:00\s*-\s*18:00/.test(document)) {
    throw new Error('Official pricing format changed; review the plugin before updating.');
  }
  const values = [...text.matchAll(/(\d+(?:\.\d+)?)\s*元/g)].map((match) => Number(match[1]));
  if (values.length !== 12 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Incomplete official price table.');
  }
  return {
    'deepseek-flash': { offPeak: [values[0], values[4], values[8]], peak: [values[2], values[6], values[10]] },
    'deepseek-v4-pro': { offPeak: [values[1], values[5], values[9]], peak: [values[3], values[7], values[11]] },
  };
}

export async function updatePrices(file = new URL('./pricing.json', import.meta.url)) {
  const response = await fetch(PRICING_URL, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new Error('Cannot fetch official prices: HTTP ' + response.status);
  let html = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    html += decoder.decode(chunk, { stream: true });
    if (html.length > 2_000_000) throw new Error('Price page exceeds limit.');
  }
  html += decoder.decode();
  const models = parseOfficialPrices(html);
  const pricing = JSON.parse(await readFile(file, 'utf8'));
  const now = new Date().toISOString();
  if (JSON.stringify(pricing.snapshots.at(-1).models) !== JSON.stringify(models)) {
    pricing.snapshots.push({ id: 'deepseek-cny-' + now, effectiveFrom: now, observedAt: now,
      currency: 'CNY', perTokens: 1000000, models });
  }
  pricing.lastCheckedAt = now;
  const temporary = new URL('./pricing-' + process.pid + '.tmp', file instanceof URL ? file : pathToFileURL(file));
  await writeFile(temporary, JSON.stringify(pricing, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await updatePrices();
  process.stdout.write('Official prices checked; historical snapshots retained.\n');
}
