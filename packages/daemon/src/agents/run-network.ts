import type { Harness } from '@mikka/protocol'
import { HARNESS_DOMAINS } from './run-context'
import { matchesRunSandboxDomain } from './run-sandbox-launcher'
import type { ToolApprovalGate } from './tool-approval'

/** Only trusted adapter code creates this closure. Neither the CLI nor IPC
 * request payload can choose a run, permission layer, or network ceiling. */
export function runNetworkApproval(runId: string, harness: Exclude<Harness, 'mock' | 'cursor'>, gate: ToolApprovalGate, maximum: readonly string[], localComputerEndpoint?: string) {
  if (gate.runId !== runId) throw new Error('Run approval scope mismatch')
  if (localComputerEndpoint !== undefined && (!/^127\.0\.0\.1:[0-9]+$/.test(localComputerEndpoint) || Number(localComputerEndpoint.split(':')[1]) < 1 || Number(localComputerEndpoint.split(':')[1]) > 65535)) throw new Error('Invalid local computer endpoint')
  const ceiling = [...maximum]
  const model = [...HARNESS_DOMAINS[harness]]
  return async (request: { host: string; port: number }, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted || gate.revoked || !matchesRunSandboxDomain(request, ceiling)) return false
    // Existing model endpoints are an explicit capability shared by the CLI
    // and descendants, not proof that traffic is model-only.
    // A trusted run-bound computer broker has its own authenticated permission
    // gate. Its exact transport endpoint must not create a second network ask.
    if (matchesRunSandboxDomain(request, model) || localComputerEndpoint === `${request.host}:${request.port}`) return await gate.checkLive() && !signal.aborted && !gate.revoked
    // The exact immutable ceiling already authorizes this destination. A new
    // socket must not ask the same question again or consume mutation receipts.
    return await gate.preapprovedNetwork({runId,harness,requestId:'network-destination',method:'sandbox/network',input:{host:request.host,port:request.port}}, signal)
      && !signal.aborted && !gate.revoked
  }
}
