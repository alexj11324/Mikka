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

/** Wait for local broker state, a server push, or an intentional retry/lease deadline. */
function waitForReviewWake(broker: ComputerBroker, sinceRevision: number, pushes: DeviceWorkSignal | undefined, timeoutMs: number | undefined, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted || broker.pendingRevision !== sinceRevision) { resolve(); return }
    let timer: ReturnType<typeof setTimeout> | undefined
    let offBroker = () => {}
    let offPush = () => {}
    const done = () => {
      if (timer) clearTimeout(timer)
      offBroker()
      offPush()
      signal.removeEventListener('abort', done)
      resolve()
    }
    offBroker = broker.onPendingChange(done)
    offPush = pushes?.subscribe(done) ?? (() => {})
    signal.addEventListener('abort', done, { once: true })
    if (timeoutMs !== undefined) timer = setTimeout(done, Math.max(0, timeoutMs))
    // Protect against a broker mutation between the first revision check and subscription.
    if (broker.pendingRevision !== sinceRevision) done()
  })
}

/** A worker owns this loop for its lifetime. Empty brokers sleep until local state changes.
 * Pending reviews retain the legacy short fallback when the server cannot push, or a bounded
 * presence refresh when push is available; gateway reconnect and every push always sync now. */
export async function pollWebComputerReviews(broker: ComputerBroker, deviceId: string, link: { syncComputerReviews?(deviceId: string, requests: LocalComputerRequest[], signal?: AbortSignal): Promise<LocalComputerDecision[]> }, signal: AbortSignal, intervalMs = 1000, pushes?: DeviceWorkSignal, presenceMs = REVIEW_PRESENCE_MS) {
  if (!link.syncComputerReviews) throw new Error('Computer review transport unavailable')
  let pushed = false
  let synced: string | undefined
  let syncedAt = 0
  let retryNeeded = false
  const unsubscribe = pushes?.subscribe(() => { pushed = true })
  try {
    while (!signal.aborted) {
      const revision = broker.pendingRevision
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
          retryNeeded = false
        } catch { retryNeeded = true /* pending calls remain unapproved; retry after a bounded wait */ }
      }
      if (signal.aborted) break
      const waitMs = retryNeeded ? intervalMs : pending
        ? (everyCheck ? intervalMs : Math.max(0, presenceMs - (Date.now() - syncedAt)))
        : undefined
      await waitForReviewWake(broker, revision, pushes, waitMs, signal)
    }
  } finally { unsubscribe?.() }
}
