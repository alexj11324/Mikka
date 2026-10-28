import { createHash } from 'node:crypto'
import { z } from 'zod'
import { OperationError } from './ledger'

const slackChannel = z.object({
  id: z.string(), is_im: z.literal(false), is_mpim: z.literal(false),
  is_member: z.literal(true), is_archived: z.literal(false),
  is_channel: z.boolean(), is_group: z.boolean(), is_private: z.boolean(),
}).passthrough()
/** Slack documents legacy G private channels as is_channel=false,is_group=true. */
export function channelSnapshot(raw: unknown, expected: unknown) {
  const parsed = slackChannel.safeParse(raw)
  if (!parsed.success) throw new OperationError('integrationTargetUnavailable')
  const c = parsed.data
  if (c.id !== expected || !(c.is_channel && !c.is_group || !c.is_channel && c.is_group && c.is_private)) throw new OperationError('integrationTargetUnavailable')
  return { targetId: c.id, is_im: false, is_mpim: false, is_member: true, is_archived: false, is_channel: c.is_channel, is_group: c.is_group, is_private: c.is_private }
}
const time = z.union([
  z.object({ date: z.iso.date() }).strict(),
  z.object({ dateTime: z.iso.datetime({ offset: true }), timeZone: z.string().min(1).optional() }).strict(),
])
const event = z.object({
  id: z.string().min(1).max(1024), etag: z.string().regex(/^"[^"\r\n]+"$/).max(1024),
  status: z.literal('confirmed'), eventType: z.literal('default'),
  organizer: z.object({ email: z.email(), self: z.literal(true) }).passthrough(),
  start: time, end: time, summary: z.string().optional(),
  attendeesOmitted: z.literal(false).optional(),
  attendees: z.array(z.object({ email: z.email(), additionalGuests: z.literal(0).optional(), asyncOperation: z.never().optional() }).passthrough()).max(200).optional(),
}).passthrough()
/** Only ordinary standalone organizer-owned events. No series master/instance,
 * hidden attendee lists, additional/async guests, or special event types.
 * Email identity is not proof that an address is not a distribution group. */
export function calendarSnapshot(raw: unknown, expected: unknown, notifications: unknown) {
  const p = event.safeParse(raw)
  if (!p.success || !['none', 'all'].includes(String(notifications))) throw new OperationError('integrationTargetUnavailable')
  const d = p.data
  if (d.id !== expected || ['recurrence', 'recurringEventId', 'originalStartTime'].some(k => Object.hasOwn(d,k))) throw new OperationError('integrationTargetUnavailable')
  return { targetId: d.id, etag: d.etag, summary: d.summary ?? '', start: d.start, end: d.end, organizer: { email: d.organizer.email, self: true }, attendees: (d.attendees ?? []).map(a => ({ ...a })).sort((a,b) => a.email.localeCompare(b.email)), sendUpdates: notifications }
}

export function snapshotDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([,x]) => x !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,canonical(x)])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
