import { DurableObject } from 'cloudflare:workers'
import { LIVE_REVISION_PARAM, liveInvalidations, liveReady, withoutRevisions, type LiveInvalidation } from '../../../lib/live/events'
import { readDevicePresenceGrant } from '../../../lib/device-presence-grant'
import { LIVE_PRESENCE_PARAM, PRESENCE_MAX_CHANNEL_WATCHES, PRESENCE_MAX_DEVICE_WATCHES, PRESENCE_MAX_WATCHES_PER_SOCKET, PRESENCE_ONLINE_MS, presenceCommand, type PresenceReply } from '../../../lib/live/presence'
import type { GatewayEnv } from './route'

const RECOVERY_CHECK_MS = 60_000
const DELIVERY_RETRY_MS = 30_000

export type DevicePresenceWatch = { observer: string; channel: string; home: string; expiresAt: number; heartbeatUntil: number; online: boolean }
type DeviceWatch = DevicePresenceWatch & { retryAt?: number }
type LiveWatch = { observer: string; socketId: string; id: string; channel: string; home: string; devices: string[]; expiresAt: number }
type PresenceState = { device: DeviceWatch[]; live: LiveWatch[] }

interface ConnectionAttachment {
  connectedAt: number
  liveExpiresAt?: number
  /** The socket asked for version 2 keys. Older tabs and the mobile app never do. */
  liveRevisions?: boolean
  /** Only explicitly negotiated sockets may register owned-device watches. */
  presence?: { channel: string; socketId: string }
}

/**
 * Hibernating WebSocket for one device.
 *
 * Cloudflare's hibernation API (`acceptWebSocket`, not `accept`) drops the
 * object from memory while the socket stays connected, so duration is not
 * billed for the idle connection. `setWebSocketAutoResponse` answers the
 * daemon's 30s `ping` without waking the object and without duration
 * (https://developers.cloudflare.com/durable-objects/api/state/ and
 * https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/).
 *
 * Only actual, short-lived list observers arrange an alarm. An unobserved
 * device has no alarm and no background request. Pings never write to Neon.
 */
export class DeviceSession extends DurableObject<GatewayEnv> {
  private deviceWatches = new Map<string, DeviceWatch>()
  private liveWatches = new Map<string, LiveWatch>()
  private controls = new Map<string, symbol>()
  private updates = Promise.resolve()
  private liveRevoked = false

  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    // Attachments stay small; bounded watches survive hibernation in this DO,
    // never in the application database. No alarm is started by construction.
    this.ctx.blockConcurrencyWhile(async () => {
      this.liveRevoked = await this.ctx.storage.get<boolean>('live-revoked') === true
      const state = await this.ctx.storage.get<PresenceState>('presence-v1')
      this.deviceWatches = new Map((state?.device ?? []).map(watch => [watch.observer, watch]))
      this.liveWatches = new Map((state?.live ?? []).map(watch => [watch.observer, watch]))
    })
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
    const protocol = request.headers.get('sec-websocket-protocol')
    if (!protocol) return new Response(null, { status: 400 })
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const url = new URL(request.url)
    const live = url.pathname.startsWith('/v1/live/')
    if (live && this.liveRevoked) return new Response(null, { status: 401 })
    const revisions = live && url.searchParams.get(LIVE_REVISION_PARAM) === '1'
    const presence = live && url.searchParams.get(LIVE_PRESENCE_PARAM) === '1'
      ? { channel: url.pathname.split('/')[3], socketId: crypto.randomUUID() } : undefined
    // A daemon reconnect replaces its previous socket. Browser tabs share
    // their owner/workspace channel until their individual tickets expire.
    for (const existing of this.ctx.getWebSockets()) {
      const expiry = (existing.deserializeAttachment() as ConnectionAttachment | null)?.liveExpiresAt
      if (!live) existing.close(4000, 'replaced')
      else if (expiry && expiry <= Date.now()) existing.close(4001, 'ticket expired')
    }
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ connectedAt: Date.now(), ...(live ? { liveExpiresAt: Number(protocol.match(/^mikka-ticket-(\d+)-/)?.[1]) * 1000 } : {}), ...(revisions ? { liveRevisions: true } : {}), ...(presence ? { presence } : {}) } satisfies ConnectionAttachment)
    if (live) {
      server.send(JSON.stringify(liveReady(revisions ? 2 : 1)))
      if (presence) this.reply(server, { type: 'presence_ready', version: 1 })
      await this.pruneLiveWatches()
    } else await this.updateDevicePresence()
    // The edge authenticated this exact ticket. Node's built-in WebSocket
    // rejects the upgrade unless its offered protocol is selected here.
    return new Response(null, {
      status: 101,
      headers: { 'sec-websocket-protocol': protocol },
      webSocket: client,
    })
  }

  /** Queried on demand. Auto-pongs update this timestamp without waking JS. */
  async status(): Promise<{ online: boolean; lastSeenAt: string | null }> {
    const { lastSeen, online } = this.deviceStatus()
    return { online, lastSeenAt: lastSeen > 0 ? new Date(lastSeen).toISOString() : null }
  }

  private deviceStatus(now = Date.now()) {
    let lastSeen = 0
    let open = false
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue
      open = true
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
      const connectedAt = attachment?.connectedAt ?? 0
      const lastPong = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0
      lastSeen = Math.max(lastSeen, connectedAt, lastPong)
    }
    return { online: lastSeen > 0 && now - lastSeen < PRESENCE_ONLINE_MS, lastSeen, open }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    // These callback statuses are reserved and cannot be sent in a close
    // frame. In particular, a client calling close() supplies code 1005.
    if (code === 1005 || code === 1006) socket.close()
    else socket.close(code, reason)
    await this.closed(socket)
  }

  async webSocketError(socket: WebSocket) {
    try { socket.close() } catch { /* the runtime may already have closed it */ }
    await this.closed(socket)
  }

  private async closed(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
    if (attachment?.liveExpiresAt) {
      for (const key of this.controls.keys()) if (key.startsWith(`${attachment.presence?.socketId}:`)) this.controls.delete(key)
      await this.dropLiveWatches([...this.liveWatches.values()].filter(watch => watch.socketId === attachment.presence?.socketId))
    } else await this.updateDevicePresence()
  }

  private reply(socket: WebSocket, value: PresenceReply) {
    try { socket.send(JSON.stringify(value)) } catch { /* a disconnected observer cannot receive coverage */ }
  }

  private observerSocket(watch: LiveWatch) {
    return this.ctx.getWebSockets().find(socket => {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
      return socket.readyState === WebSocket.OPEN && (attachment?.liveExpiresAt ?? 0) > Date.now()
        && attachment?.presence?.socketId === watch.socketId
    })
  }

  /** Client controls are accepted only on the already-authenticated home socket;
   * the separate signed grant proves which owned devices this read depends on. */
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment?.presence || (attachment.liveExpiresAt ?? 0) <= Date.now() || socket.readyState !== WebSocket.OPEN
      || typeof message !== 'string' || message.length > 2_048) return
    let command
    try { command = presenceCommand(JSON.parse(message)) } catch { return }
    if (!command) return
    const { socketId, channel } = attachment.presence
    const key = `${socketId}:${command.id}`, control = Symbol()
    if (command.type === 'presence_unwatch') {
      this.controls.delete(key)
      await this.dropLiveWatches([...this.liveWatches.values()].filter(watch => watch.socketId === socketId && watch.id === command.id))
      return
    }
    if (!this.controls.has(key) && this.controls.size >= PRESENCE_MAX_CHANNEL_WATCHES) {
      this.reply(socket, { type: 'presence_unavailable', id: command.id }); return
    }
    this.controls.set(key, control)
    try {
      await this.controlPresence(socket, attachment, command, key, control, socketId, channel)
    } finally {
      if (this.controls.get(key) === control) this.controls.delete(key)
    }
  }

  private async controlPresence(socket: WebSocket, attachment: ConnectionAttachment, command: Extract<NonNullable<ReturnType<typeof presenceCommand>>, { type: 'presence_watch' }>, key: string, control: symbol, socketId: string, channel: string) {
    const previous = [...this.liveWatches.values()].filter(watch => watch.socketId === socketId && watch.id === command.id)
    await this.dropLiveWatches(previous)
    if (this.controls.get(key) !== control || socket.readyState !== WebSocket.OPEN) return
    await this.pruneLiveWatches()
    if (this.controls.get(key) !== control || socket.readyState !== WebSocket.OPEN) return
    const grant = readDevicePresenceGrant(command.token, channel, this.env.GATEWAY_PUSH_SECRET ?? '')
    if (!grant || this.liveWatches.size >= PRESENCE_MAX_CHANNEL_WATCHES
      || [...this.liveWatches.values()].filter(watch => watch.socketId === socketId).length >= PRESENCE_MAX_WATCHES_PER_SOCKET) {
      this.reply(socket, { type: 'presence_unavailable', id: command.id }); return
    }
    const watch: LiveWatch = { observer: crypto.randomUUID(), socketId, id: command.id, channel, home: grant.home,
      devices: grant.devices.map(([id]) => id), expiresAt: Math.min(grant.expiresAt, attachment.liveExpiresAt!) }
    // Save before the RPC: a device change during registration already has a
    // listener. A late registration cannot revive a closed/unwatched socket.
    this.liveWatches.set(watch.observer, watch)
    await this.savePresence()
    await this.schedulePresence()
    const registered = await Promise.allSettled(grant.devices.map(([id, online, heartbeatUntil]) => this.env.DEVICE_SESSION.getByName(id).watchPresence({
      observer: watch.observer, channel, home: watch.home, expiresAt: watch.expiresAt, heartbeatUntil, online,
    })))
    if (this.controls.get(key) !== control || this.liveWatches.get(watch.observer) !== watch || !this.observerSocket(watch) || watch.expiresAt <= Date.now()
      || registered.some(result => result.status === 'rejected' || !result.value.accepted)) {
      await this.dropLiveWatches([watch])
      this.reply(socket, { type: 'presence_unavailable', id: command.id }); return
    }
    // A read followed by a watch is not atomic. Registration compares that
    // read's exact availability to the device's current state and catches up.
    if (registered.some(result => result.status === 'fulfilled' && result.value.changed)) {
      await this.notifyLive([{ kind: 'device_list', id: watch.home }, { kind: 'thread_list', id: watch.home }])
    }
    if (this.controls.get(key) === control && this.liveWatches.get(watch.observer) === watch) {
      this.reply(socket, { type: 'presence_ack', id: command.id, expiresAt: watch.expiresAt })
    }
  }

  /** Internal binding RPC, reached only after the live DO validates the grant. */
  async watchPresence(input: DevicePresenceWatch): Promise<{ accepted: boolean; changed: boolean }> {
    this.pruneDeviceWatches()
    if (input.expiresAt <= Date.now() || (!this.deviceWatches.has(input.observer) && this.deviceWatches.size >= PRESENCE_MAX_DEVICE_WATCHES)) return { accepted: false, changed: false }
    const online = this.deviceStatus().online || input.heartbeatUntil > Date.now()
    this.deviceWatches.set(input.observer, { ...input, online })
    await this.savePresence()
    await this.schedulePresence()
    return { accepted: true, changed: input.online !== online }
  }

  async unwatchPresence(observer: string) {
    if (!this.deviceWatches.delete(observer)) return
    await this.savePresence()
    await this.schedulePresence()
  }

  /** A device sends only keys to active observers; closed or expired watches
   * are returned as absent so their device-side state can also be removed. */
  async presenceChanged(observers: string[], home: string): Promise<string[]> {
    const active = observers.filter(observer => {
      const watch = this.liveWatches.get(observer)
      return watch && watch.home === home && watch.expiresAt > Date.now() && this.observerSocket(watch)
    })
    if (active.length) await this.notifyLive([{ kind: 'device_list', id: home }, { kind: 'thread_list', id: home }])
    return active
  }

  private async dropLiveWatches(watches: LiveWatch[], expired = false) {
    if (!watches.length) return
    for (const watch of watches) {
      this.liveWatches.delete(watch.observer)
      if (expired) {
        const socket = this.observerSocket(watch)
        if (socket) this.reply(socket, { type: 'presence_unavailable', id: watch.id })
      }
    }
    await this.savePresence()
    // Even if the live watch was already removed by close/unwatch, a late
    // registration completion calls this again to remove the device record.
    await Promise.allSettled(watches.flatMap(watch => watch.devices.map(id => this.env.DEVICE_SESSION.getByName(id).unwatchPresence(watch.observer))))
    await this.schedulePresence()
  }

  private pruneLiveWatches() {
    return this.dropLiveWatches([...this.liveWatches.values()].filter(watch => watch.expiresAt <= Date.now() || !this.observerSocket(watch)), true)
  }

  private pruneDeviceWatches() {
    for (const [id, watch] of this.deviceWatches) if (watch.expiresAt <= Date.now()) this.deviceWatches.delete(id)
  }

  private updateDevicePresence() {
    // A reconnect/close may arrive while a fanout RPC is pending. Observe again
    // in order, rather than let an older RPC overwrite the newer online state.
    const update = this.updates.then(() => this.deliverPresenceChanges())
    this.updates = update.catch(() => {})
    return update
  }

  private async deliverPresenceChanges() {
    const before = this.deviceWatches.size
    this.pruneDeviceWatches()
    const now = Date.now(), status = this.deviceStatus(now)
    const changed = new Map<string, { channel: string; home: string; watches: { watch: DeviceWatch; online: boolean }[] }>()
    let clearedRetry = false
    for (const watch of this.deviceWatches.values()) {
      const online = status.online || watch.heartbeatUntil > now
      if (watch.online === online) {
        if (watch.retryAt) { delete watch.retryAt; clearedRetry = true }
        continue
      }
      const key = `${watch.channel}:${watch.home}`
      const group = changed.get(key) ?? { channel: watch.channel, home: watch.home, watches: [] }
      group.watches.push({ watch, online }); changed.set(key, group)
    }
    await Promise.all([...changed.values()].map(async ({ channel, home, watches }) => {
      try {
        const active = new Set(await this.env.DEVICE_SESSION.getByName(`live:${channel}`).presenceChanged(watches.map(({ watch }) => watch.observer), home))
        for (const { watch, online } of watches) {
          if (this.deviceWatches.get(watch.observer) !== watch) continue
          if (!active.has(watch.observer)) this.deviceWatches.delete(watch.observer)
          else { watch.online = online; delete watch.retryAt }
        }
      } catch {
        // No application read is retried here. Only a failed key delivery gets
        // another bounded attempt while its real observer grant is still live.
        for (const { watch } of watches) if (this.deviceWatches.get(watch.observer) === watch) watch.retryAt = Date.now() + DELIVERY_RETRY_MS
      }
    }))
    if (changed.size || clearedRetry || before !== this.deviceWatches.size) await this.savePresence()
    await this.schedulePresence()
  }

  async alarm() {
    await this.pruneLiveWatches()
    await this.updateDevicePresence()
  }

  private async savePresence() {
    if (!this.deviceWatches.size && !this.liveWatches.size) await this.ctx.storage.delete('presence-v1')
    else await this.ctx.storage.put('presence-v1', { device: [...this.deviceWatches.values()], live: [...this.liveWatches.values()] } satisfies PresenceState)
  }

  private async schedulePresence() {
    const now = Date.now(), status = this.deviceStatus(now)
    const deadlines = [...this.liveWatches.values()].map(watch => watch.expiresAt)
    for (const watch of this.deviceWatches.values()) {
      deadlines.push(watch.expiresAt)
      if (watch.retryAt) deadlines.push(watch.retryAt)
      const until = Math.max(status.online ? status.lastSeen + PRESENCE_ONLINE_MS : 0, watch.heartbeatUntil)
      if (until > now) deadlines.push(until)
      // Auto-pongs do not wake JS. An observed, still-open stale socket can
      // recover on that same socket; no observer means no recovery alarm.
      else if (status.open) deadlines.push(now + RECOVERY_CHECK_MS)
    }
    if (!deadlines.length) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Math.max(now + 1, Math.min(...deadlines)))
  }

  /** Wake this device. The text is the signal only; the work stays in Neon until the device asks. */
  async notify() {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send('work') } catch { /* a closing socket is dropped by the runtime */ }
    }
  }

  /** A capability channel is never reused. Persist before acknowledging so a
   * hibernated object cannot accept an old signed ticket after revocation. */
  async revokeLive() {
    this.liveRevoked = true
    await this.ctx.storage.put('live-revoked', true)
    for (const socket of this.ctx.getWebSockets()) {
      if (!(socket.deserializeAttachment() as ConnectionAttachment | null)?.liveExpiresAt) continue
      try { socket.close(4001, 'live capability revoked') } catch { /* already closed */ }
    }
    await this.pruneLiveWatches()
  }

  /** Browser tabs share a channel; an expired ticket never receives another key. */
  async notifyLive(events: LiveInvalidation[]) {
    if (this.liveRevoked) return
    const validated = liveInvalidations(events, true)
    if (!validated) return
    const plain = withoutRevisions(validated)
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
      const expiry = attachment?.liveExpiresAt
      if (!expiry || expiry <= Date.now()) { socket.close(4001, 'ticket expired'); continue }
      // A version 1 reader drops any key with a third field, so it gets the plain key.
      try { for (const event of attachment?.liveRevisions ? validated : plain) socket.send(JSON.stringify(event)) }
      catch { try { socket.close() } catch { /* already closed */ } }
    }
  }
}
