import { randomUUID } from 'node:crypto'
import type { BundledLiveEvent } from '@mikka/protocol/bridge'
import type { BundledAuth } from './bundled-auth'

type Ticket = { url: string; protocol: string; expiresAt: number }
type Channel = { owner: number; ticket: Ticket; socket?: WebSocket; expiry: ReturnType<typeof setTimeout> }

/** The shared renderer LiveChannel still controls visibility, retries and ping.
 * Main stores the remotely usable ticket; renderer sees a random local handle. */
export class BundledLive {
  private readonly channels = new Map<string, Channel>()
  private generation = 0
  private readonly ownerGeneration = new Map<number, number>()
  constructor(private readonly auth: Pick<BundledAuth, 'request' | 'session'>, private readonly emit: (owner: number, event: BundledLiveEvent) => void) {}
  async prepare(owner: number, workspace: unknown): Promise<{ id: string; expiresAt: number } | null> {
    if (typeof workspace !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(workspace)) throw new Error('Invalid live workspace')
    if (!this.auth.session()) return null
    const generation = this.generation
    const ownerGeneration = this.ownerGeneration.get(owner) ?? 0
    if ([...this.channels.values()].filter(channel => channel.owner === owner).length >= 4) throw new Error('Too many live channels')
    const response = await this.auth.request(`/api/live/ticket?workspace=${encodeURIComponent(workspace)}`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return null
    const ticket = await response.json() as Partial<Ticket>
    if (generation !== this.generation || ownerGeneration !== (this.ownerGeneration.get(owner) ?? 0)) return null
    if (typeof ticket.url !== 'string' || typeof ticket.protocol !== 'string' || typeof ticket.expiresAt !== 'number') return null
    const target = new URL(ticket.url)
    if (target.username || target.password || target.hash || target.search || !/^(?:\/mikka)?\/v1\/live\/[a-f0-9]{64}\/socket$/.test(target.pathname) || (target.protocol !== 'wss:' && !(target.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) || ticket.protocol.length > 4096 || ticket.expiresAt <= Date.now() || ticket.expiresAt > Date.now() + 15 * 60_000) throw new Error('Invalid live ticket')
    const id = randomUUID()
    const expiry = setTimeout(() => this.close(owner, id), Math.max(0, ticket.expiresAt - Date.now()))
    expiry.unref()
    this.channels.set(id, { owner, ticket: ticket as Ticket, expiry })
    return { id, expiresAt: ticket.expiresAt }
  }
  private owned(owner: number, id: unknown): Channel | undefined {
    if (typeof id !== 'string' || id.length > 100) throw new Error('Invalid live handle')
    const channel = this.channels.get(id)
    if (channel && channel.owner !== owner) throw new Error('Untrusted live owner')
    return channel
  }
  connect(owner: number, id: unknown): void {
    const channel = this.owned(owner, id)
    if (!channel || channel.socket || channel.ticket.expiresAt <= Date.now()) throw new Error('Live handle expired')
    const handle = id as string
    clearTimeout(channel.expiry)
    const target = new URL(channel.ticket.url)
    target.searchParams.set('revisions', '1')
    const socket = new WebSocket(target, channel.ticket.protocol)
    channel.socket = socket
    socket.onopen = () => this.emit(owner, { id: handle, type: 'open' })
    socket.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 256 * 1024) { socket.close(); return }
      this.emit(owner, { id: handle, type: 'message', data: event.data })
    }
    socket.onerror = () => this.emit(owner, { id: handle, type: 'error' })
    socket.onclose = () => { this.channels.delete(handle); this.emit(owner, { id: handle, type: 'close' }) }
  }
  send(owner: number, id: unknown, data: unknown): void {
    const channel = this.owned(owner, id)
    if (data !== 'ping' || channel?.socket?.readyState !== WebSocket.OPEN) throw new Error('Invalid live message')
    channel.socket.send('ping')
  }
  close(owner: number, id: unknown): void {
    const channel = this.owned(owner, id)
    if (!channel) return
    this.channels.delete(id as string); clearTimeout(channel.expiry)
    channel.socket?.close()
  }
  closeOwner(owner: number): void { this.ownerGeneration.set(owner, (this.ownerGeneration.get(owner) ?? 0) + 1); for (const [id, channel] of this.channels) if (channel.owner === owner) this.close(owner, id) }
  closeAll(): void { this.generation++; for (const [id, channel] of this.channels) this.close(channel.owner, id) }
}
