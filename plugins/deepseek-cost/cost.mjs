// No API keys or account requests: only normalized usage and public price snapshots.
export function modelKey(model) {
  if (['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)) return 'deepseek-flash';
  if (model === 'deepseek-v4-pro' || model.startsWith('claude-opus')) return 'deepseek-v4-pro';
  if (model.startsWith('claude')) return 'deepseek-flash';
  return undefined;
}

export function pricePeriod(timestamp, calendar) {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return undefined;
  const beijing = new Date(time + 8 * 3600000);
  const date = beijing.toISOString().slice(0, 10);
  const day = beijing.getUTCDay();
  // The official rule explicitly excludes weekends, even make-up working Saturdays.
  if (day === 0 || day === 6) return 'offPeak';
  const hour = beijing.getUTCHours();
  if (!((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))) return 'offPeak';
  if (!calendar.years.includes(beijing.getUTCFullYear())) return undefined;
  if (calendar.holidays.some(([from, to]) => from <= date && date <= to)) return 'offPeak';
  return 'peak';
}

function priceUsage(input, pricing) {
  const unique = new Map(input.usageRecords.map((record) => [record.requestId, record]));
  let cost = 0;
  let unknown = input.usageIncomplete;
  let unknownRequests = 0;
  const groups = new Map();
  const mixed = [...unique.values()].some((record) => record.origin !== 'https://api.deepseek.com');
  for (const record of unique.values()) {
    if (!record.origin) { unknown = true; unknownRequests++; continue; }
    if (record.origin !== 'https://api.deepseek.com') continue;
    const key = modelKey(record.model);
    const snapshot = pricing.snapshots
      .filter((entry) => Date.parse(entry.effectiveFrom) <= Date.parse(record.startedAt))
      .sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))[0];
    const period = pricePeriod(record.startedAt, pricing.calendar);
    const rates = snapshot?.models[key]?.[period];
    const u = record.usage;
    if (!record.complete || !record.cacheBreakdownKnown || !rates ||
        snapshot.currency !== 'CNY' || snapshot.perTokens !== 1000000 ||
        Object.values(u).some((count) => !Number.isSafeInteger(count) || count < 0) ||
        u.cacheCreationTokens !== 0) {
      unknown = true;
      unknownRequests++;
      continue;
    }
    cost += (u.cacheReadTokens * rates[0] + u.inputTokens * rates[1] + u.outputTokens * rates[2]) / snapshot.perTokens;
    const groupId = JSON.stringify([snapshot.id, key, period]);
    const group = groups.get(groupId) ?? { model: key, period, rates, input: 0, cache: 0, output: 0 };
    group.input += u.inputTokens; group.cache += u.cacheReadTokens; group.output += u.outputTokens;
    groups.set(groupId, group);
  }
  return { cost, unknown, unknownRequests, mixed, groups: [...groups.values()] };
}

export function calculateCost(input, pricing) {
  if (input.current.origin !== 'https://api.deepseek.com') return { version: 1, segments: [] };
  const result = priceUsage(input, pricing);
  const { cost, mixed } = result;
  const unknown = result.unknown || !modelKey(input.current.model);
  if (unknown && result.groups.length === 0) return { version: 1, segments: [] };
  const amount = cost > 0 && cost < 0.0001 ? '<¥0.0001' : '≈¥' + cost.toFixed(4);
  const text = ' · ' + (mixed || unknown ? 'DS ' : '') + amount;
  return { version: 1, segments: [{ text, fg: '#a5d6a7' }] };
}

export function calculateTurnCost(input, pricing) {
  // A historical turn is priced only by its own records, never by the current model.
  const records = input.usageRecords.filter((record) => record.turnId === input.turn.id);
  if (records.length > 0 && records.every((record) => record.origin && record.origin !== 'https://api.deepseek.com')) {
    return { version: 1, segments: [] };
  }
  const result = priceUsage({ ...input, usageRecords: records, usageIncomplete: input.usageIncomplete || records.length === 0 }, pricing);
  const { cost, mixed, groups } = result;
  if (groups.length === 0) return { version: 1, segments: [] };
  const money = (amount) => amount > 0 && amount < 0.000001 ? '<¥0.000001' : '¥' + amount.toFixed(6);
  const label = '合计 ≈' + money(cost);
  const details = [];
  const line = (text) => ({ segments: [{ text, dim: true }] });
  for (const group of groups.slice(0, 8)) {
    details.push(line('费用构成 · ' + group.model + ' · ' + (group.period === 'peak' ? '高峰' : '空闲')));
    for (const [label, tokens, rate] of [
      ['输入（未命中）', group.input, group.rates[1]],
      ['缓存命中', group.cache, group.rates[0]],
      ['输出', group.output, group.rates[2]],
    ]) {
      details.push(line(label + ' ' + tokens.toLocaleString('en-US') + ' tok × ¥' + rate + '/百万 = ' + money(tokens * rate / 1000000)));
    }
  }
  if (groups.length > 8) details.push(line('另有 ' + (groups.length - 8) + ' 组费用，已计入合计。'));
  if (mixed) details.push(line('仅统计本轮 DeepSeek token 费用，其他服务用量未计入。'));
  return { version: 1, segments: [{ text: ' · ' + (mixed ? 'DS ' : '') + label, dim: true }], details };
}
