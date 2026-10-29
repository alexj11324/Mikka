import { createHash } from 'node:crypto'
import { z } from 'zod'
import { OperationError } from './ledger'

const slackChannel = z.object({
  id:z.string().min(1), name:z.string().optional(), user:z.string().optional(),
  is_im:z.boolean().optional(), is_mpim:z.boolean().optional(), is_member:z.boolean().optional(),
  is_archived:z.boolean().optional(), is_channel:z.boolean().optional(), is_group:z.boolean().optional(),
  is_private:z.boolean().optional(), context_team_id:z.string().optional(),
}).passthrough()
/** Record provider facts about the chosen target; the model chooses the target. */
export function channelSnapshot(raw: unknown, expected: unknown) {
  const parsed=slackChannel.safeParse(raw)
  if (!parsed.success || parsed.data.id !== expected) throw new OperationError('integrationTargetUnavailable')
  const { id, name, user, is_im, is_mpim, is_member, is_archived, is_channel, is_group, is_private, context_team_id }=parsed.data
  return { targetId:id, name, user, is_im, is_mpim, is_member, is_archived, is_channel, is_group, is_private, context_team_id }
}
const event=z.object({id:z.string().min(1).max(1024),etag:z.string().regex(/^"[^"\r\n]+"$/).max(1024)}).passthrough()
/** ETag and exact ID fence the version; event meaning stays with the model. */
export function calendarSnapshot(raw: unknown, expected: unknown, notifications: unknown) {
  const parsed=event.safeParse(raw)
  if (!parsed.success || parsed.data.id !== expected || !['none','all','externalOnly'].includes(String(notifications))) throw new OperationError('integrationTargetUnavailable')
  if (Buffer.byteLength(JSON.stringify(parsed.data)) > 64_000) throw new OperationError('integrationTargetUnavailable')
  return { ...parsed.data, targetId:parsed.data.id, sendUpdates:notifications }
}

export function snapshotDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([,x]) => x !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,canonical(x)])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
