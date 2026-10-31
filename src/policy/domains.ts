import { domainToASCII } from 'node:url';
import { BlockList, isIP } from 'node:net';

export function normalizeHost(input: string): string {
  const host = input.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (isIP(host)) return host;
  const ascii = domainToASCII(host);
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw new Error('Invalid network host: ' + input);
  }
  return ascii;
}

export function normalizeDomainPattern(input: string): string {
  const prefix = input.startsWith('**.') ? '**.' : input.startsWith('*.') ? '*.' : '';
  const host = normalizeHost(input.slice(prefix.length));
  if (prefix && isIP(host)) throw new Error('IP addresses cannot use wildcards.');
  return prefix + host;
}

export function domainMatches(pattern: string, host: string): boolean {
  const rule = normalizeDomainPattern(pattern);
  const target = normalizeHost(host);
  if (rule.startsWith('**.')) return target === rule.slice(3) || target.endsWith(rule.slice(2));
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1);
    return target.endsWith(suffix) && !target.slice(0, -suffix.length).includes('.');
  }
  return rule === target;
}

export function domainDecision(domains: Record<string, 'allow' | 'deny'>, host: string): 'allow' | 'deny' {
  let allowed = false;
  for (const [pattern, verdict] of Object.entries(domains)) {
    if (!domainMatches(pattern, host)) continue;
    if (verdict === 'deny') return 'deny';
    allowed = true;
  }
  return allowed ? 'allow' : 'deny';
}

const privateV4 = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) privateV4.addSubnet(address, bits, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const reservedV6 = new BlockList();
reservedV6.addSubnet('2001::', 23, 'ipv6');
reservedV6.addSubnet('2001:db8::', 32, 'ipv6');
reservedV6.addSubnet('2002::', 16, 'ipv6');
reservedV6.addSubnet('3fff::', 20, 'ipv6');

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return !privateV4.check(address, 'ipv4');
  if (isIP(address) === 6) return globalV6.check(address, 'ipv6') && !reservedV6.check(address, 'ipv6');
  return false;
}

/** Private destinations require an exact host allow, never a wildcard. */
export function allowsPrivateHost(domains: Record<string, 'allow' | 'deny'>, host: string): boolean {
  return domainDecision(domains, host) === 'allow' && Object.entries(domains).some(([pattern, decision]) =>
    !pattern.includes('*') && decision === 'allow' && normalizeHost(pattern) === normalizeHost(host));
}
