// Only the request-only proxy is passed to a local harness. The caller must
// supply the run's explicit computer permission; an absent policy fails shut.
export function localComputerMcp({ broker, runId, permission, readOnly, proxyPath, nodeBinary }) {
  if (readOnly || !broker || !["ask", "allow"].includes(permission)) return undefined;
  const grant = broker.spec(runId, permission);
  if (!grant) return undefined;
  return { command: nodeBinary, args: [proxyPath, grant.socketPath, grant.token], env: {} };
}
