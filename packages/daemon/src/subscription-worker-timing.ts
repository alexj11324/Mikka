// Node-only numeric observation. Never retain a request, credential or identity.
import { AsyncLocalStorage } from 'node:async_hooks'

const METHODS = ['status', 'oauthStart', 'oauthResume', 'oauthComplete', 'oauthPoll', 'oauthHandoff', 'refresh', 'recover', 'disconnect', 'nativeAuth', 'nativeContext', 'prepare', 'prepareStream', 'quota', 'usage', 'models', 'cleanup', 'execute', 'executeStream', 'nativeStream', 'acquire'] as const
type Method = typeof METHODS[number] | 'unobserved'
type IdentityMode = 'static' | 'custody_token' | 'access_token' | 'parent_snapshot' | 'unobserved'
type IdentityPhase = 'identityLogin' | 'parentAccessAuthority' | 'parentProjectionRead'
const GO_DURATIONS = ['configToServeMs', 'dbInitMs', 'rpcBodyMs', 'authorizeMs', 'prepareRecordMs', 'migrationMs', 'readyAuthMs', 'refreshMs', 'cleanupMs', 'statusMs', 'readMs', 'createMs', 'deleteMs', 'conversionMs', 'executorOpenMs', 'httpHeadersMs', 'httpFirstEventMs', 'httpFirstTextEventMs', 'firstConvertedChunkMs', 'firstChunkGuardMs', 'firstEmitMs'] as const
const GO_COUNTS = ['migrationCalls', 'refreshCalls', 'readCalls', 'createCalls', 'deleteCalls'] as const
type GoDuration = typeof GO_DURATIONS[number]
type GoCount = typeof GO_COUNTS[number]
export type WorkerGoTiming = { version: 1; accessReadBackend?: 'vault' | 'snapshot' | 'unobserved' } & Partial<Record<GoDuration | GoCount, number | null>>
const GO_KEYS = new Set<string>(['version', 'accessReadBackend', ...GO_DURATIONS, ...GO_COUNTS])

/** Unknown/malformed diagnostics never replace the original RPC result. */
function goTiming(value: unknown): WorkerGoTiming | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !GO_KEYS.has(key))) return
    const fields = value as Record<string, unknown>
    if (fields.version !== 1) return
    const result: WorkerGoTiming = { version: 1 }
    for (const key of GO_DURATIONS) {
      if (!Object.hasOwn(fields, key)) continue
      const field = fields[key]
      if (field !== null && (typeof field !== 'number' || !Number.isFinite(field) || field < 0 || field > 3_600_000)) return
      result[key] = field as number | null
    }
    for (const key of GO_COUNTS) {
      if (!Object.hasOwn(fields, key)) continue
      const field = fields[key]
      if (field !== null && (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0 || field > 1_000_000)) return
      result[key] = field as number | null
    }
    if (Object.hasOwn(fields, 'accessReadBackend')) {
      if (typeof fields.accessReadBackend !== 'string' || !['vault', 'snapshot', 'unobserved'].includes(fields.accessReadBackend)) return
      result.accessReadBackend = fields.accessReadBackend as WorkerGoTiming['accessReadBackend']
    }
    return result
  } catch { return undefined }
}


const TRANSPORT_MS = ['getConnMs', 'gotConnMs', 'dnsStartMs', 'dnsDoneMs', 'connectStartMs', 'connectDoneMs', 'tlsStartMs', 'tlsDoneMs', 'wroteRequestMs', 'firstByteMs', 'headersMs', 'firstEventMs', 'firstTextMs'] as const
const TRANSPORT_COUNTS = ['getConnCalls', 'dnsCalls', 'connectCalls', 'tlsCalls', 'writeCalls'] as const
const TRANSPORT_FLAGS = ['reused', 'dnsFailed', 'connectFailed', 'tlsFailed', 'writeFailed'] as const
export type WorkerTransportTiming = { version: 1 } & Partial<Record<typeof TRANSPORT_MS[number] | typeof TRANSPORT_COUNTS[number], number | null>> & Partial<Record<typeof TRANSPORT_FLAGS[number], boolean | null>>
const TRANSPORT_KEYS = new Set<string>(['version', ...TRANSPORT_MS, ...TRANSPORT_COUNTS, ...TRANSPORT_FLAGS])

function transportTiming(value: unknown): WorkerTransportTiming | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !TRANSPORT_KEYS.has(key))) return
    const fields = value as Record<string, unknown>
    if (!Object.hasOwn(fields, 'version') || fields.version !== 1) return
    const result: WorkerTransportTiming = { version: 1 }
    for (const key of TRANSPORT_MS) {
      if (!Object.hasOwn(fields, key)) continue
      const field = fields[key]
      if (field !== null && (typeof field !== 'number' || !Number.isFinite(field) || field < 0 || field > 3_600_000)) return
      result[key] = field === null ? null : Math.round((field as number) * 1_000) / 1_000
    }
    for (const key of TRANSPORT_COUNTS) {
      if (!Object.hasOwn(fields, key)) continue
      const field = fields[key]
      if (field !== null && (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0 || field > 1_000_000)) return
      result[key] = field as number | null
    }
    for (const key of TRANSPORT_FLAGS) {
      if (!Object.hasOwn(fields, key)) continue
      const field = fields[key]
      if (field !== null && typeof field !== 'boolean') return
      result[key] = field as boolean | null
    }
    return result
  } catch { return undefined }
}

type RequestedServiceTier = 'priority' | 'omitted'
type ActualServiceTier = 'missing' | 'priority' | 'default' | 'auto' | 'flex' | 'unrecognized'
export type WorkerServiceTier = {
  version: 1; inputRequested: RequestedServiceTier; requested: RequestedServiceTier
  created: ActualServiceTier; completed: ActualServiceTier; incomplete: ActualServiceTier
}
const SERVICE_TIER_KEYS = ['version', 'inputRequested', 'requested', 'created', 'completed', 'incomplete'] as const
const ACTUAL_SERVICE_TIERS: readonly string[] = ['missing', 'priority', 'default', 'auto', 'flex', 'unrecognized']

/** A closed receipt, independent of timing. Never retain provider strings or infer actual from requested. */
function serviceTier(value: unknown): WorkerServiceTier | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const keys = Reflect.ownKeys(value)
    if (keys.length !== SERVICE_TIER_KEYS.length || keys.some(key => typeof key !== 'string' || !SERVICE_TIER_KEYS.includes(key as typeof SERVICE_TIER_KEYS[number]))) return
    const fields: Record<string, unknown> = {}
    for (const key of SERVICE_TIER_KEYS) {
      const field = Object.getOwnPropertyDescriptor(value, key)
      if (!field || !Object.hasOwn(field, 'value')) return
      fields[key] = field.value
    }
    if (fields.version !== 1) return
    for (const key of ['inputRequested', 'requested'] as const) {
      if (fields[key] !== 'priority' && fields[key] !== 'omitted') return
    }
    for (const key of ['created', 'completed', 'incomplete'] as const) {
      if (typeof fields[key] !== 'string' || !ACTUAL_SERVICE_TIERS.includes(fields[key])) return
    }
    return { version: 1, inputRequested: fields.inputRequested as RequestedServiceTier, requested: fields.requested as RequestedServiceTier,
      created: fields.created as ActualServiceTier, completed: fields.completed as ActualServiceTier, incomplete: fields.incomplete as ActualServiceTier }
  } catch { return undefined }
}

type WorkerRow = {
  ordinal: number; method: Method; startedMs: number | null; settledMs: number | null
  outcome: 'pending' | 'result' | 'error' | 'cancelled'
  identityMode: IdentityMode; spawnToConfigWriteMs: number | null; identityMs: number | null
  identityLoginCalls: number | null; identityLoginMs: number | null
  parentAccessAuthorityCalls: number | null; parentAccessAuthorityMs: number | null
  parentProjectionReadCalls: number | null; parentProjectionReadMs: number | null
  goState: 'reported' | 'missing' | 'invalid'; go?: WorkerGoTiming
}
type PreReadOutcome = 'pending' | 'ready' | 'prepare_missing' | 'prepare_expiring' | 'error' | 'cancelled' | 'timeout'
type StreamPreRead = Pick<WorkerRow, 'startedMs' | 'settledMs' | 'identityMs' | 'identityLoginCalls' | 'identityLoginMs' | 'parentAccessAuthorityCalls' | 'parentAccessAuthorityMs' | 'parentProjectionReadCalls' | 'parentProjectionReadMs'> & { outcome: PreReadOutcome }
export type SubscriptionStages = {
  version: 1; streamEntryMs: number | null; firstIpcChunkMs: number | null; firstSdkTextMs: number | null
  workers: WorkerRow[]; overflow: number; streamPreRead?: StreamPreRead
}
const elapsed = (end: number | null, start: number | null) => end !== null && start !== null && end >= start ? Math.round((end - start) * 1_000) / 1_000 : null

export class SubscriptionCallTiming {
  private readonly origin: number | null
  private readonly workers: SubscriptionWorkerTiming[] = []
  private overflow = 0
  private preRead?: { worker: SubscriptionWorkerTiming; outcome: PreReadOutcome }
  private streamEntryMs: number | null = null
  private firstIpcChunkMs: number | null = null
  private firstSdkTextMs: number | null = null
  constructor(private readonly now: () => number = () => performance.now()) { this.origin = this.clock() }
  private clock() { try { const value = this.now(); return Number.isFinite(value) ? value : null } catch { return null } }
  offset() { return elapsed(this.clock(), this.origin) }
  streamEntry() { this.streamEntryMs ??= this.offset() }
  firstIpcChunk() { this.firstIpcChunkMs ??= this.offset() }
  firstSdkText() { this.firstSdkTextMs ??= this.offset() }
  startWorker(method: unknown) {
    if (this.workers.length === 16) { this.overflow++; return undefined }
    const row = new SubscriptionWorkerTiming(this, this.workers.length + 1, METHODS.includes(method as typeof METHODS[number]) ? method as Method : 'unobserved')
    this.workers.push(row)
    return row
  }
  startStreamPreRead() {
    if (this.preRead) return undefined
    const preRead = { worker: new SubscriptionWorkerTiming(this, 0, 'unobserved'), outcome: 'pending' as PreReadOutcome }
    this.preRead = preRead
    return { worker: preRead.worker, finish: (outcome: Exclude<PreReadOutcome, 'pending'>) => {
      if (preRead.outcome !== 'pending') return
      preRead.outcome = outcome
      preRead.worker.settle(outcome === 'cancelled' ? 'cancelled' : outcome === 'error' || outcome === 'timeout' ? 'error' : 'result')
    } }
  }
  /** Separate from the legacy stages: adding HTTP evidence never grows its log. */
  transportSnapshot() { return this.workers.filter(worker => worker.snapshot().method === 'executeStream').map(worker => worker.transportSnapshot()) }
  /** Tier receipts never change the legacy stages or HTTP timing schema. */
  serviceTierSnapshot() { return this.workers.filter(worker => worker.snapshot().method === 'executeStream').map(worker => worker.serviceTierSnapshot()) }
  snapshot(): SubscriptionStages {
    const row = this.preRead?.worker.snapshot()
    const streamPreRead: StreamPreRead | undefined = row && this.preRead ? {
      startedMs: row.startedMs, settledMs: row.settledMs, outcome: this.preRead.outcome, identityMs: row.identityMs,
      identityLoginCalls: row.identityLoginCalls, identityLoginMs: row.identityLoginMs,
      parentAccessAuthorityCalls: row.parentAccessAuthorityCalls, parentAccessAuthorityMs: row.parentAccessAuthorityMs,
      parentProjectionReadCalls: row.parentProjectionReadCalls, parentProjectionReadMs: row.parentProjectionReadMs,
    } : undefined
    return { version: 1, streamEntryMs: this.streamEntryMs, firstIpcChunkMs: this.firstIpcChunkMs, firstSdkTextMs: this.firstSdkTextMs, workers: this.workers.map(worker => worker.snapshot()), overflow: this.overflow, ...(streamPreRead ? { streamPreRead } : {}) }
  }
}

export class SubscriptionWorkerTiming {
  private readonly row: WorkerRow
  private transportState: 'reported' | 'missing' | 'invalid' = 'missing'
  private transport?: WorkerTransportTiming
  private serviceTierState: 'reported' | 'unavailable' | 'invalid' = 'unavailable'
  private serviceTier?: WorkerServiceTier
  constructor(private readonly call: SubscriptionCallTiming, ordinal: number, method: Method) {
    this.row = { ordinal, method, startedMs: call.offset(), settledMs: null, outcome: 'pending', identityMode: 'unobserved', spawnToConfigWriteMs: null, identityMs: null, identityLoginCalls: null, identityLoginMs: null, parentAccessAuthorityCalls: null, parentAccessAuthorityMs: null, parentProjectionReadCalls: null, parentProjectionReadMs: null, goState: 'missing' }
  }
  beginIdentity() {
    const started = this.call.offset()
    for (const phase of ['identityLogin', 'parentAccessAuthority', 'parentProjectionRead'] as const) { this.row[`${phase}Calls`] = 0; this.row[`${phase}Ms`] = null }
    return () => { if (this.row.outcome === 'pending') this.row.identityMs = elapsed(this.call.offset(), started) }
  }
  identityMode(mode: IdentityMode) { if (this.row.outcome === 'pending') this.row.identityMode = mode }
  phase(phase: IdentityPhase) {
    if (this.row.outcome !== 'pending') return () => undefined
    const started = this.call.offset()
    const count = `${phase}Calls` as const, duration = `${phase}Ms` as const
    this.row[count] = (this.row[count] ?? 0) + 1
    const prior = this.row[duration] ?? 0
    this.row[duration] = null // started, but may never settle before cancellation
    let done = false
    return () => {
      if (done || this.row.outcome !== 'pending') return
      done = true
      const ms = elapsed(this.call.offset(), started)
      this.row[duration] = ms === null ? null : prior + ms
    }
  }
  configWrite() { if (this.row.outcome === 'pending') this.row.spawnToConfigWriteMs = elapsed(this.call.offset(), this.row.startedMs) }
  chunk() { if (this.row.outcome === 'pending') this.call.firstIpcChunk() }
  terminal(value: unknown, present: boolean) {
    if (this.row.outcome !== 'pending' || !present) return
    const timing = goTiming(value)
    this.row.goState = timing ? 'reported' : 'invalid'
    if (timing) this.row.go = timing
  }
  terminalTransport(value: unknown, present: boolean) {
    if (this.row.outcome !== 'pending' || !present) return
    const timing = transportTiming(value)
    this.transportState = timing ? 'reported' : 'invalid'
    if (timing) this.transport = timing
  }
  transportSnapshot() { return { ordinal: this.row.ordinal, outcome: this.row.outcome, state: this.transportState, ...(this.transport ? { timing: { ...this.transport } } : {}) } }
  terminalServiceTier(value: unknown, present: boolean) {
    if (this.row.outcome !== 'pending' || !present) return
    this.serviceTier = serviceTier(value)
    this.serviceTierState = this.serviceTier ? 'reported' : 'invalid'
  }
  serviceTierSnapshot() { return { ordinal: this.row.ordinal, outcome: this.row.outcome, state: this.serviceTierState, ...(this.serviceTier ? { serviceTier: { ...this.serviceTier } } : {}) } }
  settle(outcome: Exclude<WorkerRow['outcome'], 'pending'>) {
    if (this.row.outcome !== 'pending') return
    this.row.settledMs = this.call.offset()
    this.row.outcome = outcome
  }
  snapshot(): WorkerRow { return { ...this.row, ...(this.row.go ? { go: { ...this.row.go } } : {}) } }
}

const scope = new AsyncLocalStorage<{ call: SubscriptionCallTiming; worker?: SubscriptionWorkerTiming }>()
export const currentSubscriptionTiming = () => scope.getStore()?.call
export const currentSubscriptionWorkerTiming = () => scope.getStore()?.worker
export function withSubscriptionTiming<T>(call: SubscriptionCallTiming, work: () => T): T { return scope.run({ call }, work) }
export function withSubscriptionWorkerTiming<T>(worker: SubscriptionWorkerTiming | undefined, work: () => T): T {
  const current = scope.getStore()
  return current ? scope.run({ call: current.call, worker }, work) : work()
}
