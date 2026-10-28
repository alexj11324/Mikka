import { randomUUID } from 'node:crypto'
import type { Harness } from '@mikka/protocol'
import { HARNESS_DOMAINS } from './run-context'
import { matchesRunSandboxDomain } from './run-sandbox-launcher'
import type { ToolApprovalGate } from './tool-approval'

/** Only trusted adapter code creates this closure. Neither the CLI nor IPC
 * request payload can choose a run, permission layer, or network ceiling. */
export function runNetworkApproval(runId: string, harness: Exclude<Harness, 'mock' | 'cursor'>, gate: ToolApprovalGate, maximum: readonly string[]) {
  if (gate.runId !== runId) throw new Error('Run approval scope mismatch')
  const ceiling = [...maximum]
  const model = [...HARNESS_DOMAINS[harness]]
  return async (request: { host: string; port: number }, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted || gate.revoked || !matchesRunSandboxDomain(request, ceiling)) return false
    // Existing model endpoints are an explicit capability shared by the CLI
    // and descendants, not proof that traffic is model-only.
    if (matchesRunSandboxDomain(request, model)) return await gate.checkLive() && !signal.aborted && !gate.revoked
    const decision = await gate.request({runId,harness,requestId:randomUUID(),method:'sandbox/network',input:{host:request.host,port:request.port}}, signal)
    return decision === 'allow' && !signal.aborted && !gate.revoked
  }
}
