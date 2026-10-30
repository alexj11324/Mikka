import { CiReadError } from '../../../lib/github/ci/read'
import { summarize, type Snapshot } from '../../../lib/github/ci/snapshot'
import { observe, type Observation } from '../../../lib/github/ci/observation'

/** The adapter owns durable leases and atomic fencing; no provider token or
 * credential is passed to a task or to the final result callback. */
export type CiPollLease = { id: string; generation: string; attempt: number; observation: Observation | null; token?: string; binding?: {userId:string;issueId:string;remoteKey:string;prNumber:number;installationId:number;repositoryId:number;githubAccountId:string;branch:string;originRunId:string;scopeVersion:number;issueOwner:string;issueScope:string} }
export type CiPollState = { head: string; open: boolean; snapshot: Snapshot; unchangedDelivered?:true }
export type CiPollResult = { head: string; fingerprint: string; outcome: 'success' | 'failure'; failed: string[] }
export interface CiPollAdapter {
  lease(limit: number, now: number): Promise<CiPollLease[]>
  authorize(lease:CiPollLease):Promise<{check():Promise<void>;close():Promise<void>}>
  read(lease: CiPollLease, signal: AbortSignal): Promise<CiPollState>
  /** Bypass branch-rule caches immediately before final delivery. */
  readFresh(lease: CiPollLease, signal: AbortSignal): Promise<CiPollState>
  /** Persist state and next due time only if the lease/generation is current. */
  pending(lease: CiPollLease, state: Observation | null, nextAt: number): Promise<void>
  close(lease: CiPollLease): Promise<void>
  /** Atomically fence current head and generation and enqueue an idempotent
   * final result; never call this for intermediate workflow events. */
  complete(lease: CiPollLease, state: Observation, result: CiPollResult): Promise<void>
  retry(lease: CiPollLease, nextAt: number, code: CiReadError['code']): Promise<void>
}

const BASE_MS = 15 * 60_000
const MAX_BACKOFF_MS = 60 * 60_000
const QUIET_MS = 2 * 60_000

/** One bounded scheduled batch. Overlap safety belongs to durable leases, not
 * in-memory Worker state. Failures back off and cannot be interpreted as a
 * successful or failed CI result. */
export async function pollActiveCi(adapter: CiPollAdapter, options: { now?: () => number; random?: () => number; limit?: number; deadline: number }): Promise<{ scanned:number; completed:number; pending:number; failed:number }> {
  const now = options.now ?? Date.now, random = options.random ?? Math.random
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 4)))
  const leases = await adapter.lease(limit, now())
  if (leases.length > limit) throw new Error('CI lease limit exceeded')
  const counts = {scanned:0,completed:0,pending:0,failed:0}
  for (const lease of leases) {
    counts.scanned++
    let authority: Awaited<ReturnType<CiPollAdapter['authorize']>> | undefined
    try {
      authority=await adapter.authorize(lease)
      await authority.check()
      const remaining = options.deadline - now()
      if (remaining <= 0) throw new Error('CI poll deadline exceeded')
      const current = await adapter.read(lease, AbortSignal.timeout(Math.min(remaining, 30_000)))
      if (!/^[a-f0-9]{40}$/i.test(current.head)) throw new Error('Invalid CI head')
      if (!current.open) { await adapter.close(lease); continue }
      if(current.unchangedDelivered) {
        if(!lease.observation?.deliveredFingerprint || lease.observation.head!==current.head.toLowerCase())throw new Error('Invalid CI head shortcut')
        await adapter.pending(lease,lease.observation,now()+BASE_MS)
        counts.pending++
        continue
      }
      const head = current.head.toLowerCase(), summary = summarize(current.snapshot)
      const decision = observe(lease.observation,head,summary,now(),QUIET_MS)
      if (decision.deliver && summary.kind === 'complete' && decision.state) {
        await authority.check()
        const left=options.deadline-now();if(left<=0)throw new Error('CI poll deadline exceeded')
        const fresh=await adapter.readFresh(lease,AbortSignal.timeout(Math.min(left,30_000)))
        if(!fresh.open){await adapter.close(lease);continue}
        if(!/^[a-f0-9]{40}$/i.test(fresh.head))throw new Error('Invalid CI head')
        const freshHead=fresh.head.toLowerCase(), freshSummary=summarize(fresh.snapshot)
        if(freshHead!==head||freshSummary.kind!=='complete'||freshSummary.fingerprint!==summary.fingerprint){
          await adapter.pending(lease,observe(decision.state,freshHead,freshSummary,now(),QUIET_MS).state,now()+BASE_MS)
          counts.pending++;continue
        }
        await authority.check()
        await adapter.complete(lease,decision.state,{head,fingerprint:summary.fingerprint,outcome:summary.outcome,failed:summary.failed})
        await authority.check()
        counts.completed++
      } else {
        // A bounded jitter prevents many watches from synchronizing; schedule
        // never exceeds the configured base interval.
        const delay = Math.max(QUIET_MS, Math.floor(BASE_MS * (0.8 + Math.max(0,Math.min(1,random())) * 0.2)))
        await adapter.pending(lease,decision.state,now()+delay)
        counts.pending++
      }
    } catch (error) {
      const code = error instanceof CiReadError ? error.code : 'unavailable'
      const attempt = Math.max(0, Math.min(8, lease.attempt))
      const cap = Math.min(MAX_BACKOFF_MS,BASE_MS * 2 ** attempt)
      const delay = Math.floor(cap * (0.8 + Math.max(0,Math.min(1,random())) * 0.2))
      // A concurrently superseded or expired lease needs no update; the
      // current owner or the next scheduler pass will recover it.
      await adapter.retry(lease,now()+delay,code).catch(() => undefined)
      counts.failed++
    } finally { await authority?.close() }
  }
  return counts
}
