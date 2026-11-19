import type { LocalComputerDecision, LocalComputerRequest } from '@mikka/protocol/computer'
import type { ComputerBroker } from './broker.mjs'
import type { DeviceWorkSignal } from '../device-work-signal'
import { ServerUnreachableError } from '../errors'
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
export async function syncWebComputerReviews(broker: ComputerBroker, deviceId: string, link: { syncComputerReviews?(deviceId: string, requests: LocalComputerRequest[], signal?: AbortSignal): Promise<LocalComputerDecision[]> }, signal?: AbortSignal) {
  if (!link.syncComputerReviews) throw new Error('Computer review transport unavailable')
  const decisions = await link.syncComputerReviews(deviceId, webComputerSnapshots(broker), signal)
  if (signal?.aborted) return
  await applyWebComputerDecisions(broker, decisions)
}

/** What identifies a broker snapshot: a sync is news only when this changes. */
function snapshotKey(requests: { id: string; digest: string }[]) {
  return requests.map(row => `${row.id}:${row.digest}`).sort().join(',')
}

/** A worker owns this loop for its lifetime. A failed upload cannot approve a
 * call; retrying preserves the original pending request and digest.
 *
 * Nothing here runs on a timer (decision 2026-11-17-2215). The server is asked
 * only while the device session is open, and only when something happened:
 * the broker's pending set changed, the gateway pushed (a person decided in
 * the web), or the socket opened (a push may have been lost while it was
 * down). A sync the server could not take asks for a redial through
 * `onUnreachable`; the reopened socket syncs again. */
export async function followWebComputerReviews(broker: ComputerBroker, deviceId: string, link: { syncComputerReviews?(deviceId: string, requests: LocalComputerRequest[], signal?: AbortSignal): Promise<LocalComputerDecision[]> }, signal: AbortSignal, pushes: DeviceWorkSignal, onUnreachable?: () => void) {
  if (!link.syncComputerReviews) throw new Error('Computer review transport unavailable')
  // Clear stale server requests once on the first open and after a nonempty
  // snapshot: an empty snapshot differs from the last one synced.
  let pushed = true
  let changed = true
  let synced: string | undefined
  let wake: (() => void) | null = null
  const nudge = () => { const done = wake; wake = null; done?.() }
  const offPush = pushes.subscribe(() => { pushed = true; nudge() })
  const offBroker = broker.onPendingChange(() => { changed = true; nudge() })
  const onAbort = () => nudge()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    while (!signal.aborted) {
      if (pushes.live && (pushed || changed)) {
        const snapshot = broker.list() as LocalComputerRequest[]
        const key = snapshotKey(snapshot)
        if (key !== synced || (pushed && snapshot.length > 0)) {
          pushed = false
          changed = false
          try {
            await syncWebComputerReviews(broker, deviceId, link, signal)
            synced = key
          } catch (error) {
            // Pending calls remain unapproved; the next push, change or open retries.
            if (error instanceof ServerUnreachableError) onUnreachable?.()
          }
          continue
        }
        pushed = false
        changed = false
      }
      if (signal.aborted) break
      await new Promise<void>(resolve => { wake = resolve; if (signal.aborted) nudge() })
    }
  } finally {
    offPush()
    offBroker()
    signal.removeEventListener('abort', onAbort)
  }
}
