import { readDevicePresenceGrant } from '../device-presence-grant'
import { PRESENCE_MAX_CHANNEL_WATCHES, PRESENCE_MAX_DEVICE_WATCHES, PRESENCE_MAX_WATCHES_PER_SOCKET, type PresenceCommand, type PresenceReply } from '../live/presence'
import type { GatewayBus, GatewayPeer, GatewaySocket } from './hub'

export type DeviceSnapshot = { key: string; connection: string; source: string; seen: number; online: boolean }
type Observation = { version: number; resolved: boolean; snapshot: DeviceSnapshot | null; online: boolean; heartbeatUntil: number;
  monitored?: string; monitor?: symbol; release?: () => void }
type Watch = { key: string; peer: GatewayPeer; channel: string; home: string; id: string; expiresAt: number;
  devices: Map<string, Observation>; controller: AbortController; dirty: boolean; acknowledged: boolean;
  refreshing?: Promise<void>; timer?: ReturnType<typeof setTimeout> }
// Bounds the whole process as well as each protocol-defined channel/device.
const MAX_WATCHES = 1_024

/** Grants come from the existing authenticated reads. Only signed home keys,
 * device ids and availability live here; never credentials or user content. */
export class PresenceWatches {
  private watches = new Map<string, Watch>()
  private devices = new Map<string, Set<Watch>>()

  constructor(private secret: string, private bus: GatewayBus, private now: () => number,
    private snapshot: (keys: string[], signal: AbortSignal) => Promise<Map<string, DeviceSnapshot>>,
    private send: (peer: GatewayPeer, reply: PresenceReply) => void,
    private invalidate: (channel: string, home: string) => void) {}

  get supported() { return !!this.secret && !!this.bus.observe }

  async command(peer: GatewayPeer, socket: GatewaySocket, command: PresenceCommand) {
    if (!this.supported || socket.kind !== 'live' || !socket.presence || socket.expiresAt <= this.now()) return
    const key = `${peer.id}:${command.id}`
    const previous = this.watches.get(key)
    if (previous) this.drop(previous)
    if (command.type === 'presence_unwatch') return
    const grant = readDevicePresenceGrant(command.token, socket.key, this.secret, this.now())
    if (!grant || this.watches.size >= MAX_WATCHES
      || [...this.watches.values()].filter(watch => watch.channel === socket.key).length >= PRESENCE_MAX_CHANNEL_WATCHES
      || [...this.watches.values()].filter(watch => watch.peer.id === peer.id).length >= PRESENCE_MAX_WATCHES_PER_SOCKET
      || grant.devices.some(([id]) => (this.devices.get(id)?.size ?? 0) >= PRESENCE_MAX_DEVICE_WATCHES)) {
      this.send(peer, { type: 'presence_unavailable', id: command.id }); return
    }
    const watch: Watch = { key, peer, channel: socket.key, home: grant.home, id: command.id,
      expiresAt: Math.min(grant.expiresAt, socket.expiresAt), controller: new AbortController(), dirty: true, acknowledged: false,
      devices: new Map(grant.devices.map(([id, online, heartbeatUntil]) => [id,
        { version: 0, resolved: false, snapshot: null, online, heartbeatUntil }])) }
    // Index before any asynchronous read. Every subsequent claim/change is
    // either applied to that exact generation or requires a trailing snapshot.
    this.watches.set(key, watch)
    for (const id of watch.devices.keys()) {
      const entries = this.devices.get(id) ?? new Set<Watch>()
      entries.add(watch); this.devices.set(id, entries)
    }
    this.schedule(watch)
    await this.refresh(watch)
  }

  changed(snapshot: DeviceSnapshot, claim = false) {
    for (const watch of this.devices.get(snapshot.key) ?? []) {
      const observation = watch.devices.get(snapshot.key)!
      if (!claim && observation.resolved && observation.snapshot
        && (observation.snapshot.connection !== snapshot.connection || observation.snapshot.source !== snapshot.source)) continue
      observation.version++
      if (claim || observation.snapshot) {
        observation.snapshot = snapshot; observation.resolved = true
      } else observation.resolved = false
      watch.dirty = true
      void this.refresh(watch)
    }
  }

  close(peer: GatewayPeer) {
    for (const watch of this.watches.values()) if (watch.peer.id === peer.id) this.drop(watch)
  }

  stop() { for (const watch of this.watches.values()) this.drop(watch) }

  private active(watch: Watch) { return this.watches.get(watch.key) === watch && watch.expiresAt > this.now() }

  private refresh(watch: Watch): Promise<void> {
    if (watch.refreshing) return watch.refreshing
    const refresh = this.update(watch).catch(() => this.unavailable(watch))
    watch.refreshing = refresh
    void refresh.finally(() => {
      if (watch.refreshing === refresh) watch.refreshing = undefined
      if (this.active(watch) && watch.dirty) void this.refresh(watch)
    })
    return refresh
  }

  private async update(watch: Watch) {
    while (this.active(watch) && watch.dirty) {
      watch.dirty = false
      const unresolved = [...watch.devices].filter(([, value]) => !value.resolved)
      if (unresolved.length) {
        const versions = new Map(unresolved.map(([key, value]) => [key, value.version]))
        const states = await this.snapshot(unresolved.map(([key]) => key), watch.controller.signal)
        if (!this.active(watch)) return
        for (const [key, value] of unresolved) {
          if (value.version === versions.get(key)) { value.snapshot = states.get(key) ?? null; value.resolved = true }
          if (!value.resolved) watch.dirty = true
        }
      }
      if (watch.dirty) continue
      for (const value of watch.devices.values()) {
        const source = value.snapshot?.source
        if (value.monitored === source) continue
        value.monitor = undefined; value.monitored = undefined
        value.release?.(); value.release = undefined
        if (!source) continue
        const monitor = Symbol()
        value.monitor = monitor
        const release = await this.bus.observe!(source, () => {
          if (this.active(watch) && value.monitor === monitor && value.snapshot?.source === source) this.unavailable(watch)
        }, watch.controller.signal)
        if (!this.active(watch) || value.monitor !== monitor || value.snapshot?.source !== source) { release(); continue }
        value.monitored = source; value.release = release
      }
      if (!this.active(watch)) return
      if (watch.dirty) continue
      let changed = false
      for (const value of watch.devices.values()) {
        const online = value.snapshot?.online === true || value.heartbeatUntil > this.now()
        if (value.online !== online) { value.online = online; changed = true }
      }
      if (changed) this.invalidate(watch.channel, watch.home)
      if (!this.active(watch)) return
      if (!watch.acknowledged) {
        watch.acknowledged = true
        this.send(watch.peer, { type: 'presence_ack', id: watch.id, expiresAt: watch.expiresAt })
      }
      this.schedule(watch)
    }
  }

  private schedule(watch: Watch) {
    clearTimeout(watch.timer)
    if (this.watches.get(watch.key) !== watch) return
    if (watch.expiresAt <= this.now()) { this.unavailable(watch); return }
    const now = this.now()
    const deadlines = [watch.expiresAt, ...[...watch.devices.values()].map(value => value.heartbeatUntil).filter(at => at > now)]
    watch.timer = setTimeout(() => {
      if (this.watches.get(watch.key) !== watch) return
      if (watch.expiresAt <= this.now()) this.unavailable(watch)
      else { watch.dirty = true; void this.refresh(watch) }
    }, Math.max(1, Math.min(...deadlines) - now))
    watch.timer.unref?.()
  }

  private unavailable(watch: Watch) {
    if (this.watches.get(watch.key) !== watch) return
    this.drop(watch)
    this.send(watch.peer, { type: 'presence_unavailable', id: watch.id })
    // A lost producer can no longer deliver its offline edge. Catch up now;
    // the client retains its existing fallback until another grant is covered.
    this.invalidate(watch.channel, watch.home)
  }

  private drop(watch: Watch) {
    if (this.watches.get(watch.key) === watch) this.watches.delete(watch.key)
    clearTimeout(watch.timer)
    watch.controller.abort()
    for (const [id, observation] of watch.devices) {
      observation.monitor = undefined
      observation.release?.()
      const entries = this.devices.get(id)
      entries?.delete(watch)
      if (!entries?.size) this.devices.delete(id)
    }
  }
}
