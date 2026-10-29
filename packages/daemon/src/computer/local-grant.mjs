// Only the request-only proxy is passed to a local harness. The caller must
// supply the run's explicit computer permission; an absent policy fails shut.
export function localComputerMcp({ broker, runId, permission, readOnly, proxyPath, nodeBinary }) {
  if (!broker) return undefined;
  // Even a rejected replacement must invalidate the run's old grant.
  const grant = broker.spec(runId, readOnly ? "deny" : permission);
  if (!grant) return undefined;
  return { command: nodeBinary, args: [proxyPath, grant.socketPath, grant.token], env: {} };
}
