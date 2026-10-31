export interface ExecutionSandbox {
  kind: string;
  network: 'none' | 'local' | 'all' | 'proxy';
}

/** Best-effort interpretation of a failed command; use its launch-time policy. */
export function sandboxFailure(output: string, failed: boolean, sandbox?: ExecutionSandbox): {
  denied: boolean;
  networkDenied: boolean;
  hint?: string;
} {
  if (!failed || sandbox === undefined) return { denied: false, networkDenied: false };
  const permissionFailure = /Operation not permitted|\bEPERM\b|sandbox-exec:.*deny/iu.test(output);
  const socketFailure = /server_bind|socketserver|socket\.bind|\b(?:bind|listen|connect)\b/iu.test(output);
  const dnsFailure = /Could not resolve host|Network is unreachable|Temporary failure in name resolution|nodename nor servname provided/iu.test(output);
  const networkDenied = sandbox.network !== 'all' && ((permissionFailure && socketFailure) || dnsFailure);
  const hint = !networkDenied ? undefined : sandbox.network === 'none'
    ? 'This process was launched with network=none, which also denies local server bind/listen. ' +
      'Retry the requested local server with ProcessStart network: "local" (or Shell network: "local" for a local client). ' +
      'The harness will ask the user to allow local networking for that execution/process group only, without a profile switch or restart. ' +
      'File isolation stays active. Bind explicitly to 127.0.0.1 or ::1: Seatbelt local networking includes this host’s interface addresses ' +
      'and cannot prevent wildcard listeners from being exposed to the LAN. If approval is denied or unavailable, stop.'
    : sandbox.network === 'proxy' ? 'This process uses a domain-restricted HTTP(S) proxy. Direct TCP/UDP is denied. Use a proxy-aware HTTP(S) client and request needed domains explicitly.'
    : 'This process was launched with network=local. Seatbelt permits destinations on this machine, including its ' +
      'interface addresses, and denies other hosts. Use a native 127.0.0.1 / ::1 address for local servers. ' +
      'An existing process keeps its launch-time sandbox after a profile change.';
  return { denied: permissionFailure || networkDenied, networkDenied, ...(hint === undefined ? {} : { hint }) };
}
