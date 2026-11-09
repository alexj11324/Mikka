import { AsyncLocalStorage } from 'node:async_hooks'
import { COMMIT_EXECUTOR } from '../db/commit-effects'
import { currentRoute } from '../tracing/labels'
import { isLiveRevisionKind, LIVE_ID } from '../live/events'
import type { LiveScope } from '../live/scope'
import { liveRevisionKey, readLiveRevisions, type LiveRef, type LiveRevisions } from '../live/revisions'
import { readBatchOwnerRevisionKinds, readBatchWorkspaceRevisionKinds, type BatchReadAction } from './read-batch-contract'

type Database = Parameters<typeof readLiveRevisions>[0]
type RevisionRead = { ref: LiveRef; resolve: (revision: number | undefined) => void; reject: (error: unknown) => void }
type RevisionQueue = { values: Map<string, Promise<number | undefined>>; pending: Map<string, RevisionRead>; scheduled: boolean }
type BatchContext = {
  active: boolean
  owners: Map<object, Map<string, Promise<LiveScope | null>>>
  revisions: Map<object, RevisionQueue>
  subscriptionPolicies: Map<object, Map<string, Promise<boolean>>>
  ownerRevisionKinds: ReturnType<typeof readBatchOwnerRevisionKinds>
  workspaceRevisionKinds: ReturnType<typeof readBatchWorkspaceRevisionKinds>
}
const batches = new AsyncLocalStorage<BatchContext>()
type PolicyObservation = Pick<BatchContext, 'active' | 'subscriptionPolicies'>
const policyObservations = new AsyncLocalStorage<PolicyObservation>()

/** Only explicitly read-only callers open this lifetime. Execution and ordinary
 * permission checks remain fresh; a Native batch keeps its existing observation. */
export async function withReadOnlyPolicyObservation<T>(read: () => Promise<T>): Promise<T> {
  if (/^(?:after|cron|workflow):/.test(currentRoute() ?? '') || batches.getStore()?.active || policyObservations.getStore()?.active) return read()
  const scope: PolicyObservation = { active: true, subscriptionPolicies: new Map() }
  try { return await policyObservations.run(scope, read) }
  finally { scope.active = false; scope.subscriptionPolicies.clear() }
}

/** Installed only by the bounded read action. Detached after-work cannot keep
 * using the batch's authority/revision observations once its items settle. */
export async function withReadBatchContext<T>(work: () => Promise<T>, actions: readonly BatchReadAction[] = []): Promise<T> {
  const scope: BatchContext = { active: true, owners: new Map(), revisions: new Map(), subscriptionPolicies: new Map(), ownerRevisionKinds: readBatchOwnerRevisionKinds(actions), workspaceRevisionKinds: readBatchWorkspaceRevisionKinds(actions) }
  try { return await batches.run(scope, work) }
  finally { scope.active = false; scope.owners.clear(); scope.revisions.clear(); scope.subscriptionPolicies.clear() }
}

/** Chat model readers consult the same workspace policy for keys and subscriptions.
 * Share only its observation in this read batch; each consumer keeps its own
 * data and authority checks. A request proxy must name its actual executor.
 * Deferred jobs have their own observation even while the parent is active. */
export function readBatchSubscriptionPolicy(database: object, workspaceId: string, read: () => Promise<boolean>): Promise<boolean> {
  const batch = batches.getStore()
  const scope = batch?.active ? batch : policyObservations.getStore()
  if (!scope?.active || /^(?:after|cron|workflow):/.test(currentRoute() ?? '')) return read()
  const executor = (database as { [COMMIT_EXECUTOR]?: object })[COMMIT_EXECUTOR] ?? database
  let policies = scope.subscriptionPolicies.get(executor)
  if (!policies) { policies = new Map(); scope.subscriptionPolicies.set(executor, policies) }
  let pending = policies.get(workspaceId)
  if (!pending) { pending = Promise.resolve().then(read); policies.set(workspaceId, pending) }
  return pending
}

export function readBatchOwnerScope(database: object, ownerId: string, read: () => Promise<LiveScope | null>): Promise<LiveScope | null> {
  const scope = batches.getStore()
  if (!scope?.active) return read()
  let owners = scope.owners.get(database)
  if (!owners) { owners = new Map(); scope.owners.set(database, owners) }
  let pending = owners.get(ownerId)
  if (!pending) { pending = Promise.resolve().then(read); owners.set(ownerId, pending) }
  return pending
}

/** A prepared batch already knows its owner-list kinds, but never their home.
 * Once the original reader resolves that home, read those counters together.
 * Later readers keep the conservative earlier values; only this reader's
 * original refs leave the helper. Missing/failed counters remain no proof. */
export async function readBatchOwnerRevisions(database: Database, refs: readonly LiveRef[], home?: LiveScope | null): Promise<LiveRevisions> {
  const scope = batches.getStore()
  if (!scope?.active || !home || !scope.ownerRevisionKinds.length) return readBatchRevisions(database, refs)
  const requested = new Set(refs.filter(ref => isLiveRevisionKind(ref.kind) && LIVE_ID.test(ref.id))
    .map(ref => liveRevisionKey(ref.kind, ref.id.toLowerCase())))
  // An entity read or another home cannot start this owner's list prefetch.
  if (!scope.ownerRevisionKinds.some(kind => requested.has(liveRevisionKey(kind, home.workspaceId.toLowerCase()))))
    return readBatchRevisions(database, refs)
  const values = await readBatchRevisions(database, [...refs, ...scope.ownerRevisionKinds.map(kind => ({ kind, id: home.workspaceId }))])
  return Object.fromEntries(Object.entries(values).filter(([key]) => requested.has(key)))
}

/** The caller has already authorized this exact workspace. Only prepared
 * workspace-list readers can start its bounded plan; entity and Personal-home
 * readers keep their own paths. No authorization result is cached here. */
export async function readBatchWorkspaceRevisions(database: Database, refs: readonly LiveRef[], workspace: LiveScope | null): Promise<LiveRevisions> {
  const scope = batches.getStore()
  if (!scope?.active || /^(?:after|cron|workflow):/.test(currentRoute() ?? '')) return readLiveRevisions(database, refs)
  if (!workspace || !LIVE_ID.test(workspace.workspaceId) || !scope.workspaceRevisionKinds.length) return readBatchRevisions(database, refs)
  const requested = new Set(refs.filter(ref => isLiveRevisionKind(ref.kind) && LIVE_ID.test(ref.id))
    .map(ref => liveRevisionKey(ref.kind, ref.id.toLowerCase())))
  if (!scope.workspaceRevisionKinds.some(kind => requested.has(liveRevisionKey(kind, workspace.workspaceId.toLowerCase()))))
    return readBatchRevisions(database, refs)
  const values = await readBatchRevisions(database, [...refs, ...scope.workspaceRevisionKinds.map(kind => ({ kind, id: workspace.workspaceId }))])
  return Object.fromEntries(Object.entries(values).filter(([key]) => requested.has(key)))
}

/** Each caller still awaits the revision before its data. Keys arriving in the
 * same microtask share one SQL statement; already observed keys keep the older
 * value, never a newer revision that could acknowledge unseen data. */
export async function readBatchRevisions(database: Database, refs: readonly LiveRef[]): Promise<LiveRevisions> {
  const scope = batches.getStore()
  if (!scope?.active) return readLiveRevisions(database, refs)
  const executor = (database as { [COMMIT_EXECUTOR]?: object })[COMMIT_EXECUTOR] ?? database
  let queue = scope.revisions.get(executor)
  if (!queue) { queue = { values: new Map(), pending: new Map(), scheduled: false }; scope.revisions.set(executor, queue) }
  const selected = new Map<string, Promise<number | undefined>>()
  for (const ref of refs) {
    if (!isLiveRevisionKind(ref.kind) || !LIVE_ID.test(ref.id)) continue
    const id = ref.id.toLowerCase(), key = liveRevisionKey(ref.kind, id)
    let value = queue.values.get(key)
    if (!value) {
      value = new Promise<number | undefined>((resolve, reject) => { queue!.pending.set(key, { ref: { kind: ref.kind, id }, resolve, reject }) })
      queue.values.set(key, value)
    }
    selected.set(key, value)
  }
  if (queue.pending.size && !queue.scheduled) {
    queue.scheduled = true
    const waiting = queue
    queueMicrotask(() => {
      const reads = [...waiting.pending]
      waiting.pending.clear(); waiting.scheduled = false
      void readLiveRevisions(database, reads.map(([, value]) => value.ref)).then(
        values => { for (const [key, value] of reads) value.resolve(values[key]) },
        error => { for (const [, value] of reads) value.reject(error) },
      )
    })
  }
  const observed = await Promise.all([...selected].map(async ([key, value]) => [key, await value] as const))
  return Object.fromEntries(observed.filter((entry): entry is readonly [string, number] => entry[1] !== undefined))
}
