import { LIVE_CHANNEL, LIVE_ID } from './events'

/** Presence is negotiated separately: old v1/v2 readiness shapes stay exact. */
export const LIVE_PRESENCE_PARAM = 'presence'
export const PRESENCE_MAX_DEVICES = 16
export const PRESENCE_MAX_TOKEN_BYTES = 1_900
export const PRESENCE_MAX_WATCHES_PER_SOCKET = 8
export const PRESENCE_MAX_CHANNEL_WATCHES = 64
export const PRESENCE_MAX_DEVICE_WATCHES = 64
export const PRESENCE_GRANT_MS = 300_000
export const PRESENCE_ONLINE_MS = 90_000
const WATCH_ID = /^[a-zA-Z0-9_-]{1,64}$/

/** The existing authorized read supplies only owned device ids and the state it
 * showed. A legacy heartbeat remains online until its already-known deadline. */
export type PresenceDevice = readonly [id: string, online: boolean, heartbeatUntil: number]
export type PresenceGrant = { channel: string; home: string; expiresAt: number; devices: PresenceDevice[] }
export type PresenceProof = { token: string; expiresAt: number }
export type PresenceCommand = { type: 'presence_watch'; id: string; token: string } | { type: 'presence_unwatch'; id: string }
export type PresenceReply = { type: 'presence_ready'; version: 1 }
  | { type: 'presence_ack'; id: string; expiresAt: number }
  | { type: 'presence_unavailable'; id: string }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const watchId = (value: unknown): value is string => typeof value === 'string' && WATCH_ID.test(value)
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Bounded, closed-schema metadata only. Neither prompts nor device credentials
 * are accepted by the live socket. Unknown control frames leave fallback on. */
export function presenceCommand(value: unknown): PresenceCommand | null {
  if (!object(value) || !watchId(value.id)) return null
  if (value.type === 'presence_unwatch' && Object.keys(value).length === 2) return { type: value.type, id: value.id }
  if (value.type === 'presence_watch' && Object.keys(value).length === 3 && typeof value.token === 'string'
    && value.token.length <= PRESENCE_MAX_TOKEN_BYTES && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value.token)) {
    return { type: value.type, id: value.id, token: value.token }
  }
  return null
}

export function presenceReply(value: unknown): PresenceReply | null {
  if (!object(value)) return null
  const size = Object.keys(value).length
  if (value.type === 'presence_ready' && value.version === 1 && size === 2) return { type: value.type, version: 1 }
  if (!watchId(value.id)) return null
  if (value.type === 'presence_ack' && size === 3 && timestamp(value.expiresAt)) return { type: value.type, id: value.id, expiresAt: value.expiresAt }
  if (value.type === 'presence_unavailable' && size === 2) return { type: value.type, id: value.id }
  return null
}

export function presenceGrantPayload(value: unknown, now = Date.now()): PresenceGrant | null {
  if (!object(value) || Object.keys(value).length !== 4 || typeof value.channel !== 'string' || !LIVE_CHANNEL.test(value.channel)
    || typeof value.home !== 'string' || !LIVE_ID.test(value.home) || !timestamp(value.expiresAt)
    || value.expiresAt <= now || value.expiresAt > now + PRESENCE_GRANT_MS + 5_000
    || !Array.isArray(value.devices) || !value.devices.length || value.devices.length > PRESENCE_MAX_DEVICES) return null
  const ids = new Set<string>(), devices: PresenceDevice[] = []
  for (const device of value.devices) {
    if (!Array.isArray(device) || device.length !== 3 || typeof device[0] !== 'string' || !LIVE_ID.test(device[0])
      || typeof device[1] !== 'boolean' || !timestamp(device[2]) || device[2] > value.expiresAt) return null
    const id = device[0].toLowerCase()
    if (ids.has(id)) return null
    ids.add(id); devices.push([id, device[1], device[2]])
  }
  return { channel: value.channel, home: value.home.toLowerCase(), expiresAt: value.expiresAt, devices }
}
