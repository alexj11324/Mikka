import { randomUUID } from 'node:crypto'
import type { BundledViewerEvent, BundledViewerInput, BundledViewerResult } from '@mikka/protocol/bridge'
import type { BundledAuth } from './bundled-auth'
import { WORKSPACE_ID } from './session-vault'

const MAX_OUTBOUND = 1024 * 1024
const MAX_INBOUND = 16 * 1024 * 1024
const MAX_BUFFERED = 8 * 1024 * 1024
const SEND_BUDGET = 4 * 1024 * 1024
const RECEIVE_BUDGET = 64 * 1024 * 1024
type Viewer = { owner: number; scope: string; url: string; expiresAt: number; expiry: ReturnType<typeof setTimeout>; socket?: WebSocket; sent: number; received: number; windowStarted: number; receiveWindowStarted: number }

/** Only URLs minted by the existing E2B viewer services are connectable. The
 * renderer cannot provide a URL, headers, subprotocol or arbitrary destination. */
export function validViewerGrant(value: unknown, now = Date.now()): { url: string; expiresAt: number } | null {
  if (!value || typeof value !== 'object') return null
  const grant = value as { url?: unknown; expiresAt?: unknown }
  if (typeof grant.url !== 'string' || grant.url.length > 8192 || typeof grant.expiresAt !== 'string') return null
  const expiresAt = Date.parse(grant.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 15 * 60_000) return null
  try {
    const url = new URL(grant.url)
    if (url.protocol !== 'wss:' || url.username || url.password || url.port || url.hash || !/^(?:6080|6082)-[a-z0-9-]+(?:\.[a-z0-9-]+)?\.e2b\.(?:app|dev)$/.test(url.hostname)) return null
    if (url.pathname !== '/vnc' && !/^\/agents\/[0-9a-f-]{36}\/viewer$/i.test(url.pathname)) return null
    if (url.pathname === '/vnc' ? !url.hostname.startsWith('6080-') : !url.hostname.startsWith('6082-')) return null
    const token = url.searchParams.get('token')
    if (url.searchParams.size !== 1 || !token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null
    return { url: url.href, expiresAt }
  } catch { return null }
}

/** Binary data is bounded at both IPC and socket boundaries; lifetime belongs
 * to the main frame, account, selected workspace and server-issued expiry. */
export class BundledViewer {
  private readonly viewers = new Map<string, Viewer>()
  private generation = 0
  private readonly ownerGeneration = new Map<number, number>()
  constructor(
    private readonly auth: Pick<BundledAuth, 'request' | 'scope'>,
    private readonly emit: (owner: number, event: BundledViewerEvent) => void,
    private readonly socket: (url: string) => WebSocket = url => new WebSocket(url),
  ) {}

  async prepare(owner: number, raw: unknown): Promise<BundledViewerResult> {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid viewer request')
    const input = raw as BundledViewerInput
    if (typeof input.botId !== 'string' || !WORKSPACE_ID.test(input.botId) || !['view', 'control'].includes(input.mode) || (input.takeover !== undefined && typeof input.takeover !== 'boolean') || (input.subagentId !== undefined && (typeof input.subagentId !== 'string' || !WORKSPACE_ID.test(input.subagentId))) || (input.subagentId && (input.takeover || input.mode !== 'view'))) throw new Error('Invalid viewer request')
    const scope = this.auth.scope()
    if (!scope) return { status: 401, body: { error: 'authRequired' } }
    if ([...this.viewers.values()].filter(viewer => viewer.owner === owner).length >= 16) return { status: 429, body: { error: 'viewerLimitReached' } }
    const generation = this.generation
    const ownerGeneration = this.ownerGeneration.get(owner) ?? 0
    const path = input.subagentId ? `/api/bots/${input.botId}/subagents/${input.subagentId}/viewer` : `/api/bots/${input.botId}/computer/${input.takeover ? 'takeover' : 'viewer'}`
    const response = await this.auth.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.takeover || input.subagentId ? {} : { mode: input.mode }), signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return { status: response.status, body: { error: 'viewerUnavailable' } }
    const grant = validViewerGrant(await response.json())
    if (!grant) return { status: 502, body: { error: 'viewerUnavailable' } }
    if (generation !== this.generation || ownerGeneration !== (this.ownerGeneration.get(owner) ?? 0) || scope !== this.auth.scope()) return { status: 409, body: { error: 'viewerExpired' } }
    const id = randomUUID()
    const expiry = setTimeout(() => this.close(owner, id), grant.expiresAt - Date.now())
    expiry.unref()
    this.viewers.set(id, { owner, scope, ...grant, expiry, sent: 0, received: 0, windowStarted: Date.now(), receiveWindowStarted: Date.now() })
    return { status: 200, body: { url: `wss://desktop-viewer.invalid/${id}`, expiresAt: new Date(grant.expiresAt).toISOString() } }
  }

  private owned(owner: number, raw: unknown): Viewer | undefined {
    if (typeof raw !== 'string' || !WORKSPACE_ID.test(raw)) throw new Error('Invalid viewer handle')
    const viewer = this.viewers.get(raw)
    if (viewer && viewer.owner !== owner) throw new Error('Untrusted viewer owner')
    if (viewer && (viewer.scope !== this.auth.scope() || viewer.expiresAt <= Date.now())) { this.close(owner, raw); return undefined }
    return viewer
  }

  connect(owner: number, raw: unknown): void {
    const viewer = this.owned(owner, raw)
    if (!viewer || viewer.socket) throw new Error('Viewer expired')
    const id = raw as string
    const socket = this.socket(viewer.url)
    socket.binaryType = 'arraybuffer'
    viewer.socket = socket
    socket.onopen = () => {
      if (viewer.scope !== this.auth.scope()) { this.close(owner, id); return }
      this.emit(owner, { id, type: 'open' })
    }
    socket.onmessage = event => {
      if (viewer.scope !== this.auth.scope() || !(event.data instanceof ArrayBuffer) || event.data.byteLength > MAX_INBOUND) { this.close(owner, id); return }
      const now = Date.now()
      if (now - viewer.receiveWindowStarted >= 1000) { viewer.receiveWindowStarted = now; viewer.received = 0 }
      viewer.received += event.data.byteLength
      if (viewer.received > RECEIVE_BUDGET) { this.close(owner, id); return }
      this.emit(owner, { id, type: 'message', data: new Uint8Array(event.data) })
    }
    socket.onerror = () => this.emit(owner, { id, type: 'error' })
    socket.onclose = () => this.close(owner, id)
  }

  send(owner: number, raw: unknown, input: unknown): void {
    const viewer = this.owned(owner, raw)
    if (!viewer?.socket || viewer.socket.readyState !== WebSocket.OPEN || !(input instanceof Uint8Array) || input.byteLength > MAX_OUTBOUND) throw new Error('Invalid viewer message')
    const now = Date.now()
    if (now - viewer.windowStarted >= 1000) { viewer.windowStarted = now; viewer.sent = 0 }
    viewer.sent += input.byteLength
    if (viewer.sent > SEND_BUDGET || viewer.socket.bufferedAmount > MAX_BUFFERED) { this.close(owner, raw); throw new Error('Viewer backpressure limit') }
    viewer.socket.send(input)
  }

  close(owner: number, raw: unknown): void {
    if (typeof raw !== 'string') throw new Error('Invalid viewer handle')
    const viewer = this.viewers.get(raw)
    if (!viewer) return
    if (viewer.owner !== owner) throw new Error('Untrusted viewer owner')
    this.viewers.delete(raw); clearTimeout(viewer.expiry)
    if (viewer.socket) { viewer.socket.onclose = null; viewer.socket.onmessage = null; viewer.socket.onerror = null; viewer.socket.onopen = null; viewer.socket.close() }
    this.emit(owner, { id: raw, type: 'close' })
  }
  closeOwner(owner: number): void { this.ownerGeneration.set(owner, (this.ownerGeneration.get(owner) ?? 0) + 1); for (const [id, viewer] of this.viewers) if (viewer.owner === owner) this.close(owner, id) }
  closeAll(): void { this.generation++; for (const [id, viewer] of this.viewers) this.close(viewer.owner, id) }
}
