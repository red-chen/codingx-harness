import { networkInterfaces } from 'node:os';
import type { NetworkPolicy } from './types.js';

export const LOCAL_NETWORK_NOTICE = 'Local networking permits connections to this machine, including its interface addresses. ' +
  'Seatbelt does not enforce loopback-only binding: explicitly bind servers to 127.0.0.1 or ::1 to avoid LAN exposure. ' +
  'Filesystem isolation remains active.';

export function networkMode(policy: NetworkPolicy): 'none' | 'local' | 'all' {
  return policy.enabled ? policy.mode ?? 'all' : 'none';
}

/** Native localhost filtering covers addresses assigned to this machine, not other LAN hosts. */
export function isLocalHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || Object.values(networkInterfaces()).flat().some((entry) => entry?.address.toLowerCase() === normalized);
}
