import { DE, diagRecord } from '@/lib/diagnostics/issue1512-native-reads.mjs'
import { carryReadDispatch } from '@/lib/swr/read-observer'
import { MAX_READ_BATCH, READ_BATCH_ACTION, type BatchReadAction, type ReadBatchItem } from '@/lib/desktop-rpc/read-batch-contract'
import type { Locale } from './location'

// These fetchers return their response snapshot without merging cached rows or
// issuing a second read, so its actual dispatch can prove live coverage.
const snapshotReads: ReadonlySet<string> = new Set([
  'task-runs.pollTaskRuns', 'coordinator.pollBotChatSummaries', 'bots.pollBots',
  'teams.listTeams', 'team-relations.listProjectTeams',
])
export const isSnapshotReadAction = (action: string) => snapshotReads.has(action)

export class DesktopTransportError extends Error {
  readonly status?: number
  constructor(readonly code: string, options?: ErrorOptions & { status?: number }) {
    super(code, options)
    this.name = 'DesktopTransportError'
    this.status = options?.status
  }
}

type ReadContext = { locale: Locale; workspace: string | null; currentWorkspace: () => string | null; isCurrent?: () => boolean; onDispatch?: () => void; diagnosticAction?: number }
type Send = (action: string, args: unknown[], context: { locale: Locale; isCurrent: () => boolean; onDispatch?: () => void; diagnosticActions?: readonly number[] }) => Promise<unknown>
type Pending = ReadContext & {
  action: BatchReadAction; args: unknown[]; generation: number; send: Send
  resolve: (result: unknown) => void; reject: (error: unknown) => void
}
let generation = 0
let pending: Pending[] = []
let scheduled = false
let unavailable = false

const current = (item: Pending) => item.generation === generation && item.workspace === item.currentWorkspace() && item.isCurrent?.() !== false
const changed = (cause?: unknown) => new DesktopTransportError('desktop_session_changed', { status: 409, cause })
const reject = (item: Pending, cause: unknown) => item.reject(current(item) ? cause : changed(cause))

/** A document-local fence, not an identity or authorization cache. The ordinary
 * App invalidation calls this before old reads can use a new main-process scope. */
export function resetReadBatchScope() {
  generation++
  diagRecord(DE.scopeReset, generation, pending.length)
  const retired = pending
  pending = []
  for (const item of retired) item.reject(changed())
}

async function single(item: Pending) {
  try {
    const result = await item.send(item.action, item.args, { locale: item.locale, isCurrent: () => current(item),
      diagnosticActions: [item.diagnosticAction ?? 0],
      ...(item.onDispatch ? { onDispatch: item.onDispatch } : {}),
    })
    if (!current(item)) throw changed()
    item.resolve(result)
  } catch (cause) { reject(item, cause) }
}

function validItems(value: unknown, count: number): value is ReadBatchItem[] {
  return Array.isArray(value) && value.length === count && value.every(item => {
    if (!item || typeof item !== 'object') return false
    if (item.ok === true) return Object.hasOwn(item, 'result')
    return item.ok === false && Number.isInteger(item.status) && item.status >= 400 && item.status <= 599
      && typeof item.error?.code === 'string' && item.error.code.length > 0 && item.error.code.length <= 120
  })
}

async function batch(items: Pending[]) {
  try {
    // Keep arguments raw: callRemoteAction encodes the entire envelope once,
    // and its decoded item results must not pass through the codec again.
    const result = await items[0].send(READ_BATCH_ACTION, [items.map(({ action, args }) => ({ action, args }))], {
      locale: items[0].locale, isCurrent: () => items.every(current),
      diagnosticActions: items.map(item => item.diagnosticAction ?? 0),
      ...(items.some(item => item.onDispatch) ? { onDispatch: () => { for (const item of items) item.onDispatch?.() } } : {}),
    })
    if (!validItems(result, items.length)) throw new DesktopTransportError('desktop_rpc_response_invalid', { status: 200 })
    for (let index = 0; index < items.length; index++) {
      const item = items[index], value = result[index]
      if (!current(item)) item.reject(changed())
      else if (value.ok) item.resolve(isSnapshotReadAction(item.action) ? carryReadDispatch(result, value.result) : value.result)
      else item.reject(new DesktopTransportError(value.error.code, { status: value.status }))
    }
  } catch (cause) {
    // Only this explicit capability response proves none of the reads ran.
    // Network/server failures must never silently duplicate work.
    if (items.every(current) && cause instanceof DesktopTransportError && cause.status === 404 && cause.code === 'desktop_rpc_action_unknown') {
      unavailable = true
      await Promise.all(items.map(single))
    } else for (const item of items) reject(item, cause)
  }
}

function flush() {
  scheduled = false
  const queued = pending
  pending = []
  const groups: Pending[][] = []
  for (const item of queued) {
    if (!current(item)) { item.reject(changed()); continue }
    const group = groups.find(group => group[0].locale === item.locale && group[0].workspace === item.workspace && group[0].isCurrent === item.isCurrent)
    if (group) group.push(item)
    else groups.push([item])
  }
  for (const group of groups) for (let index = 0; index < group.length; index += MAX_READ_BATCH) {
    const items = group.slice(index, index + MAX_READ_BATCH)
    if (unavailable || items.length === 1) for (const item of items) void single(item)
    else void batch(items)
  }
}

function scheduleFlush() {
  scheduled = true
  // List fetchers cross different already-resolved hydration promises. A
  // microtask flush splits those reads even though they belong to the same
  // browser turn. One posted task lets that turn's microtasks drain, without
  // a timeout, polling, or retaining the channel after the flush.
  const channel = new MessageChannel()
  channel.port1.onmessage = () => {
    channel.port1.close()
    channel.port2.close()
    flush()
  }
  channel.port2.postMessage(null)
}

/** Reads becoming ready in the same turn join. A flush owns no response cache
 * or timer; later live invalidations still perform their normal fresh reads. */
export function enqueueRead<T>(action: BatchReadAction, args: unknown[], context: ReadContext, send: Send): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const item: Pending = { ...context, action, args, generation, send, resolve: result => resolve(result as T), reject }
    if (unavailable) { void single(item); return }
    pending.push(item)
    if (!scheduled) scheduleFlush()
  })
}
