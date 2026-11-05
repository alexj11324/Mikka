import type { LocalComputerDecision, LocalComputerRequest } from '@mikka/protocol/computer'
import type { ComputerBroker } from './broker.mjs'
import type { DeviceWorkSignal } from '../device-work-signal'
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

/** The server accepts a person's decision only on a request this device showed
 * in the last 10 s (lib/computer/reviews.ts), so a pending request is re-sent
 * at least this often even when nothing changed. */
export const REVIEW_PRESENCE_MS = 5_000

/** What identifies a broker snapshot: a sync is news only when this changes. */
function snapshotKey(requests: { id: string; digest: string }[]) {
  return requests.map(row => `${row.id}:${row.digest}`).sort().join(',')
}

/** A worker owns this loop for its lifetime. A failed upload cannot approve a
 * call; retrying preserves the original pending request and digest.
 *
 * The broker is checked locally every `intervalMs`. The server is asked only
 * when something changed (#1212): the pending set, a gateway push (a person
 * decided in the web), or the presence refresh above. Against a server that
 * does not push review decisions, or while the gateway is down, a pending
 * request is synced every `intervalMs` as before, so a decision still lands
 * within a second. */
export async function pollWebComputerReviews(broker: ComputerBroker, deviceId: string, link: { syncComputerReviews?(deviceId: string, requests: LocalComputerRequest[], signal?: AbortSignal): Promise<LocalComputerDecision[]> }, signal: AbortSignal, intervalMs = 1000, pushes?: DeviceWorkSignal, presenceMs = REVIEW_PRESENCE_MS) {
  if (!link.syncComputerReviews) throw new Error('Computer review transport unavailable')
  // Clear stale server requests once on startup and after a nonempty snapshot:
  // an empty snapshot differs from the last one synced. A failed upload may
  // have reached the server, so the same snapshot is retried until it succeeds.
  // Empty brokers still check locally at the existing cadence.
  let pushed = false
  let synced: string | undefined
  let syncedAt = 0
  const unsubscribe = pushes?.subscribe(() => { pushed = true })
  try {
    while (!signal.aborted) {
      const snapshot = broker.list() as LocalComputerRequest[]
      const pending = snapshot.length > 0
      const key = snapshotKey(snapshot)
      const everyCheck = (pushes?.mode('computerReviews') ?? 'legacy') !== 'push'
      if (key !== synced || (pending && (pushed || everyCheck || Date.now() - syncedAt >= presenceMs))) {
        pushed = false
        try {
          await syncWebComputerReviews(broker, deviceId, link, signal)
          synced = key
          syncedAt = Date.now()
        } catch { /* pending calls remain unapproved; failed cleanup retries */ }
      }
      if (signal.aborted) break
      // A push ends the local wait early: the decision is applied now, not on the next check.
      if (pushes) await pushes.next(intervalMs, signal)
      else await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, intervalMs)
        signal.addEventListener('abort', done, { once: true })
        if (signal.aborted) done()
      })
    }
  } finally { unsubscribe?.() }
}
