import { createHmac, timingSafeEqual } from 'node:crypto'
import { CodedError } from '@mikka/protocol/coded-error'
import { DEVICE_GATEWAY_TICKET_SECONDS } from '../device-gateway-ticket'
import { LIVE_CHANNEL } from './events'

const PREFIX = 'mikka-live-v2-'
export const liveSessionIdValid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256
  && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
const signature = (channel: string, sessionId: string, exp: number, secret: string) => createHmac('sha256', secret)
  .update(JSON.stringify(['mikka:live:session:v2', channel, sessionId, exp])).digest('hex')

/** A session id is an identifier, never its bearer. No credential enters URLs or notifications. */
export function sessionLiveTicket(channel: string, sessionId: string, secret: string, now = Date.now(), expiresAt?: number) {
  if (!LIVE_CHANNEL.test(channel) || !liveSessionIdValid(sessionId) || !secret) throw new CodedError('desktop_session_expired')
  const exp = Math.min(Math.floor(now / 1000) + DEVICE_GATEWAY_TICKET_SECONDS, expiresAt === undefined ? Infinity : Math.floor(expiresAt / 1000))
  if (!Number.isSafeInteger(exp) || exp * 1000 <= now) throw new CodedError('desktop_session_expired')
  const encoded = Buffer.from(sessionId).toString('base64url')
  return { protocol: `${PREFIX}${exp}.${encoded}.${signature(channel, sessionId, exp, secret)}`, expiresAt: exp * 1000 }
}

/** Signature validation is followed by a fresh session lookup at upgrade and open. */
export function readSessionLiveTicket(channel: string, offered: string, secret: string, now = Date.now()) {
  if (!secret || !LIVE_CHANNEL.test(channel) || offered.length > 4096) return null
  const protocols = offered.split(',').map(value => value.trim()).filter(value => value.startsWith(PREFIX))
  if (protocols.length !== 1) return null
  const protocol = protocols[0]
  const match = /^mikka-live-v2-([0-9]{1,12})\.([A-Za-z0-9_-]{1,342})\.([a-f0-9]{64})$/.exec(protocol)
  if (!match) return null
  const exp = Number(match[1]), sessionId = Buffer.from(match[2], 'base64url').toString('utf8')
  if (!liveSessionIdValid(sessionId) || Buffer.from(sessionId).toString('base64url') !== match[2]
    || !Number.isSafeInteger(exp) || exp * 1000 <= now) return null
  const expected = signature(channel, sessionId, exp, secret)
  if (!timingSafeEqual(Buffer.from(match[3]), Buffer.from(expected))) return null
  return { protocol, sessionId, expiresAt: exp * 1000 }
}
