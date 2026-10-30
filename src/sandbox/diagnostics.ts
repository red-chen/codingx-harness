export interface ExecutionSandbox {
  kind: string;
  network: 'none' | 'local' | 'all';
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
      'For local development, the user can select /permissions :workspace-local in TUI, or restart with ' +
      'codingx --permission-profile :workspace-local, then start a new process. File isolation stays active. ' +
      'Bind explicitly to 127.0.0.1 or ::1: Seatbelt local mode includes this machine’s interface addresses ' +
      'and cannot prevent wildcard listeners from being exposed to the LAN. Ordinary command approval does not change this policy.'
    : 'This process was launched with network=local. Seatbelt permits destinations on this machine, including its ' +
      'interface addresses, and denies other hosts. Use a native 127.0.0.1 / ::1 address for local servers. ' +
      'An existing process keeps its launch-time sandbox after a profile change.';
  return { denied: permissionFailure || networkDenied, networkDenied, ...(hint === undefined ? {} : { hint }) };
}
