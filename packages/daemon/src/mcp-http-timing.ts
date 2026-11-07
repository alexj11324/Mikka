import { runIdHash } from './tracing'

type Harness = 'claude_code' | 'codex'
type Operation = 'decision_catalogue' | 'decision_record'
type Child = { child: number; startedAt: number; closedAt: number | null; lastSequence: number; sent: number; completed: number; lost: number }
type Request = { child: number; sequence: number; operation: Operation; startedAt: number; endedAt: number | null
  durationMs: number | null; status: number | null; outcome: 'ok' | 'error' | 'pending'
  body: { endedAt: number; durationMs: number; outcome: 'read' | 'error' } | null }

/** Only received child generations are observable. A CLI may kill or restart
 * a child before it reports anything; neither a paired request nor CLI exit
 * proves an inventory of every first-party HTTP send. */
export type McpHttpTiming = {
  version: 2; source: 'mikka_mcp_physical_fetch'; scope: 'observed_mikka_mcp_children'
  generationCoverage: 'unverified'; allFirstPartyHttpComplete: false
  runIdHash: string; harness: Harness; startedAt: number; endedAt: number
  expectedChildren: 1; observedChildren: number; closedChildren: number
  observedComplete: boolean; childLifecycleComplete: boolean; rejectedEvents: number; truncated: boolean
  /** Only remote MCP servers configured by this host, not arbitrary CLI plugins or user HOME configuration. */
  remoteMcpServerCount: number; childPathAuditVersion: 1
  children: Child[]; requests: Request[]
}

export const MCP_HTTP_CHILD_LIMIT = 8
export const MCP_HTTP_REQUEST_LIMIT = 128
export const MCP_HTTP_BODY_LIMIT = 4096
const COUNTER_LIMIT = 1_000_000
const BASE_KEYS = ['version', 'child', 'type', 'sequence', 'at', 'lost']
const EXTRA_KEYS: Record<string, string[]> = {
  child_start: [], request_start: ['request', 'operation'],
  request_end: ['request', 'durationMs', 'status', 'outcome'], child_close: ['sent', 'completed'],
  request_body_end: ['request', 'durationMs', 'outcome'],
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined
const count = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= COUNTER_LIMIT
const epoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** The random receiver path binds these events to the host's run. Raw child
 * identifiers are kept only as map keys and never enter the emitted receipt.
 * Closed schemas reject, rather than retain, arbitrary payload fields. */
export class McpHttpTimingCollector {
  private readonly startedAt: number
  private readonly children = new Map<string, Child>()
  private readonly requests: Request[] = []
  private readonly pending = new Map<string, Request>()
  private rejectedEvents = 0
  private truncated = false
  private closed = false

  constructor(readonly runId: string, readonly harness: Harness, readonly remoteMcpServerCount: number,
    private readonly now: () => number = Date.now) {
    if (!Number.isInteger(remoteMcpServerCount) || remoteMcpServerCount < 0 || remoteMcpServerCount > 64) throw new Error('mcp_observation_scope_invalid')
    this.startedAt = now()
  }

  reject() { if (!this.closed) this.rejectedEvents++ }
  truncate() { if (!this.closed) this.truncated = true }

  accept(input: unknown): boolean {
    if (this.closed) return false
    const event = object(input)
    const extra = typeof event?.type === 'string' && Object.hasOwn(EXTRA_KEYS, event.type) ? EXTRA_KEYS[event.type] : undefined
    const keys = extra && [...BASE_KEYS, ...extra]
    if (!event || !keys || Object.keys(event).length !== keys.length || Object.keys(event).some(key => !keys.includes(key))
      || event.version !== 2 || typeof event.child !== 'string' || !/^[a-f0-9]{32}$/.test(event.child)
      || !count(event.sequence) || event.sequence < 1 || !count(event.lost) || !epoch(event.at)
      || event.at < this.startedAt || event.at > this.now()) return this.invalid()

    const child = this.children.get(event.child)
    if (event.type === 'child_start') {
      if (child || event.sequence !== 1) return this.invalid()
      if (this.children.size >= MCP_HTTP_CHILD_LIMIT) { this.truncate(); return this.invalid() }
      this.children.set(event.child, { child: this.children.size + 1, startedAt: event.at, closedAt: null,
        lastSequence: 1, sent: 0, completed: 0, lost: event.lost })
      return true
    }
    if (!child || child.closedAt !== null || event.sequence !== child.lastSequence + 1 || event.at < child.startedAt || event.lost < child.lost)
      return this.invalid()

    if (event.type === 'request_start') {
      if (!count(event.request) || event.request !== child.sent + 1 || typeof event.operation !== 'string'
        || !['decision_catalogue', 'decision_record'].includes(event.operation)) return this.invalid()
      if (this.requests.length >= MCP_HTTP_REQUEST_LIMIT) { this.truncate(); return this.invalid() }
      const request: Request = { child: child.child, sequence: event.request, operation: event.operation as Operation,
        startedAt: event.at, endedAt: null, durationMs: null, status: null, outcome: 'pending', body: null }
      this.requests.push(request); this.pending.set(`${child.child}:${event.request}`, request); child.sent++
    } else if (event.type === 'request_end') {
      const request = count(event.request) ? this.pending.get(`${child.child}:${event.request}`) : undefined
      if (!request || event.at < request.startedAt || typeof event.durationMs !== 'number' || !Number.isFinite(event.durationMs)
        || event.durationMs < 0 || event.durationMs > 86_400_000
        || !(event.status === null || Number.isInteger(event.status) && Number(event.status) >= 100 && Number(event.status) <= 599)
        || event.outcome !== (event.status !== null && Number(event.status) >= 200 && Number(event.status) < 300 ? 'ok' : 'error')) return this.invalid()
      Object.assign(request, { endedAt: event.at, durationMs: event.durationMs, status: event.status, outcome: event.outcome })
      this.pending.delete(`${child.child}:${event.request}`); child.completed++
    } else if (event.type === 'request_body_end') {
      const request = count(event.request) ? this.requests.find(row => row.child === child.child && row.sequence === event.request) : undefined
      if (!request || request.endedAt === null || request.status === null || request.body !== null
        || event.at < request.endedAt || typeof event.durationMs !== 'number' || !Number.isFinite(event.durationMs)
        || event.durationMs < request.durationMs! || event.durationMs > 86_400_000
        || (event.outcome !== 'read' && event.outcome !== 'error')) return this.invalid()
      request.body = { endedAt: event.at, durationMs: event.durationMs, outcome: event.outcome as 'read' | 'error' }
    } else if (event.type === 'child_close') {
      const at = event.at
      if (event.sent !== child.sent || event.completed !== child.completed || child.sent !== child.completed
        || this.requests.some(request => request.child === child.child && (request.endedAt === null || request.endedAt > at
          || request.body !== null && request.body.endedAt > at))) return this.invalid()
      child.closedAt = event.at
    } else return this.invalid()
    child.lastSequence = event.sequence; child.lost = event.lost
    return true
  }

  private invalid(): false { this.reject(); return false }

  finish(): McpHttpTiming {
    this.closed = true
    const children = [...this.children.values()].map(child => ({ ...child }))
    const closedChildren = children.filter(child => child.closedAt !== null).length
    const observedComplete = children.length > 0 && this.pending.size === 0 && this.rejectedEvents === 0 && !this.truncated
      && children.every(child => child.lost === 0 && child.sent === child.completed)
    return { version: 2, source: 'mikka_mcp_physical_fetch', scope: 'observed_mikka_mcp_children',
      generationCoverage: 'unverified', allFirstPartyHttpComplete: false, runIdHash: runIdHash(this.runId), harness: this.harness,
      startedAt: this.startedAt, endedAt: this.now(), expectedChildren: 1, observedChildren: children.length, closedChildren,
      observedComplete, childLifecycleComplete: observedComplete && closedChildren === children.length,
      rejectedEvents: this.rejectedEvents, truncated: this.truncated, remoteMcpServerCount: this.remoteMcpServerCount,
      childPathAuditVersion: 1, children, requests: this.requests.map(request => ({ ...request,
        body: request.body === null ? null : { ...request.body } })) }
  }
}
