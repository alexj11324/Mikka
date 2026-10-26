import type { LocalComputerDecision, LocalComputerRequest } from '@mikka/protocol/computer'
import type { ComputerBroker } from './broker.mjs'
/** The device remains the only execution authority. Server decisions never supply operation arguments. */
export async function applyWebComputerDecisions(broker: ComputerBroker, decisions: LocalComputerDecision[]) {
  for (const decision of decisions) {
    const snapshot = broker.list().find(row => row.id === decision.id)
    if (!snapshot || snapshot.digest !== decision.digest) continue
    // Local CLI/race/replay may have consumed it. Never retry the underlying driver.
    await broker.decide(decision.id, decision.digest, decision.approve).catch(() => undefined)
  }
}
export function webComputerSnapshots(broker: ComputerBroker): LocalComputerRequest[] {
  // The broker is stricter at execution; transport parsing rejects unknown schema before upload.
  return broker.list() as LocalComputerRequest[]
}

/** One authenticated sync; failures leave the broker pending and never approve. */
export async function syncWebComputerReviews(broker: ComputerBroker, deviceId: string, link: { syncComputerReviews?(deviceId: string, requests: LocalComputerRequest[]): Promise<LocalComputerDecision[]> }) {
  if (!link.syncComputerReviews) throw new Error('Computer review transport unavailable')
  const decisions = await link.syncComputerReviews(deviceId, webComputerSnapshots(broker))
  await applyWebComputerDecisions(broker, decisions)
}
