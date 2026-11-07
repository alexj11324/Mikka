import 'server-only'
import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { isCloudEdition } from '@/lib/edition'
import { cloudClient, cloudRequest } from '@/lib/cloud-services/runtime'
import { CloudServiceError } from '@/lib/cloud-services/errors'
import { readCloudJson } from '@/lib/cloud-services/transport'
import { openSecret, sealSecret, type Sealed } from '@/lib/secrets/crypto'

const EXPO = 'https://exp.host/--/api/v2/push'
type Notification = { to: string[]; title: string; body: string; data: Record<string, unknown>; collapseId?: string }
type Receipt = { id: string; token: string; proof?: string }
const FAILURE_CODES = ['message_too_big', 'rate_limited', 'provider_credentials', 'provider_unavailable'] as const
type FailureCode = typeof FAILURE_CODES[number]
type Delivery = { invalidTokens: string[]; tickets: Receipt[]; failures: { token: string; code: FailureCode }[] }
const aad = (id: string) => `mobile_push_receipts\0${id}`
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const failureCode = (value: unknown): FailureCode => value === 'MessageTooBig' ? 'message_too_big' : value === 'MessageRateExceeded' ? 'rate_limited' : value === 'InvalidCredentials' || value === 'MismatchSenderId' ? 'provider_credentials' : 'provider_unavailable'
const knownFailure = (value: unknown): value is FailureCode => typeof value === 'string' && (FAILURE_CODES as readonly string[]).includes(value)

/** Reminder mode changes content before crossing the server boundary. */
export function phonePushPayload(message: Notification, content: 'full' | 'reminder', locale: 'zh-CN' | 'en'): Notification {
  if (content === 'full') return message
  const { serverUrl, userId, botId } = message.data
  return { ...message, title: 'Mikka', body: locale === 'en' ? 'New message' : '新消息', data: { serverUrl, userId, botId } }
}

async function expo(path: 'send' | 'getReceipts', body: unknown) {
  let response: Response
  try { response = await fetch(`${EXPO}/${path}`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', accept: 'application/json',
    ...(process.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }) }
  catch (cause) { throw new CloudServiceError('cloud_unavailable', 'network', cause) }
  return readCloudJson(response)
}

/** The source owner filters every deletion; a provider cannot remove another account's token. */
async function removeTokens(userId: string, tokens: string[]) {
  if (tokens.length) await pool.query('DELETE FROM mobile_push_tokens WHERE "userId"=$1 AND token=ANY($2::text[])', [userId, tokens])
}

export async function deliverPhonePush(userId: string, notification: Notification, locale: 'zh-CN' | 'en'): Promise<void> {
  const hosted = isCloudEdition(), provider = hosted ? 'expo' : 'cloud'
  const content = hosted ? 'full' : await cloudClient.pushContent()
  const message = phonePushPayload(notification, content, locale)
  let rejected: FailureCode | undefined
  for (let offset = 0; offset < message.to.length; offset += 100) {
    const batch = message.to.slice(offset, offset + 100)
    let delivery: Delivery
    if (hosted) {
      const result = await expo('send', batch.map(to => ({ to, title: message.title, body: message.body, data: message.data, sound: 'default', ...(message.collapseId ? { collapseId: message.collapseId } : {}) })))
      if (!Array.isArray(result.data) || result.data.length !== batch.length) throw new CloudServiceError('cloud_unavailable', 'protocol')
      delivery = { invalidTokens: [], tickets: [], failures: [] }
      result.data.forEach((item: unknown, index: number) => {
        if (!item || typeof item !== 'object') throw new CloudServiceError('cloud_unavailable', 'protocol')
        const ticket = item as { status?: string; id?: string; details?: { error?: string } }
        if (ticket.status === 'ok' && typeof ticket.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(ticket.id)) delivery.tickets.push({ token: batch[index], id: ticket.id })
        else if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') delivery.invalidTokens.push(batch[index])
        else if (ticket.status === 'error') delivery.failures.push({ token: batch[index], code: failureCode(ticket.details?.error) })
        else throw new CloudServiceError('cloud_unavailable', 'protocol')
      })
    } else {
      let result: Record<string, unknown>
      try { result = await readCloudJson(await cloudRequest(userId, 'push', '/v1/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...message, to: batch }) })) }
      catch (error) {
        // A disconnected or unselected optional service has no outbound request.
        if (error instanceof CloudServiceError && ['cloud_not_connected', 'cloud_scope_missing'].includes(error.code)) return
        throw error
      }
      const failures = result.failures ?? []
      if (!Array.isArray(result.invalidTokens) || !Array.isArray(result.tickets) || !Array.isArray(failures)
        || result.invalidTokens.some(token => typeof token !== 'string' || !batch.includes(token))
        || result.tickets.some(item => !item || typeof item !== 'object' || !batch.includes(item.token) || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(item.id) || typeof item.proof !== 'string' || !/^\d{10}\.[a-f0-9]{64}$/.test(item.proof))
        || failures.some(item => !object(item) || typeof item.token !== 'string' || !batch.includes(item.token) || !knownFailure(item.code))) throw new CloudServiceError('cloud_unavailable', 'protocol')
      delivery = { invalidTokens: result.invalidTokens as string[], tickets: result.tickets as Receipt[], failures: failures as Delivery['failures'] }
    }
    await removeTokens(userId, delivery.invalidTokens)
    if (delivery.tickets.length) {
      const id = randomUUID()
      await pool.query('INSERT INTO mobile_push_receipts(id,user_id,provider,secret) VALUES($1,$2,$3,$4)', [id, userId, provider, sealSecret(JSON.stringify(delivery.tickets), aad(id))])
      try {
        const { start } = await import('workflow/api')
        const { phonePushReceipts } = await import('@/workflows/phone-push-receipts/workflow')
        await start(phonePushReceipts, [id])
      } catch {
        // The row's due time is committed first. The existing reconciliation
        // sweep can check receipts even if the process dies or this wake fails.
        console.error('phone_push_receipts_start_failed', { code: 'workflow_unavailable' })
      }
    }
    if (delivery.failures.length) {
      rejected ??= delivery.failures[0].code
      console.error('phone_push_provider_rejected', { count: delivery.failures.length, codes: [...new Set(delivery.failures.map(failure => failure.code))] })
    }
  }
  // Bounded housekeeping is tied to sending, not a new poller.
  await pool.query("DELETE FROM mobile_push_receipts WHERE id IN (SELECT id FROM mobile_push_receipts WHERE created_at < now()-interval '1 day' ORDER BY created_at LIMIT 100)")
  // Accepted tickets are durable before reporting partial failure. This path
  // never resends notifications that Expo has already accepted.
  if (rejected) throw new CloudServiceError(rejected === 'rate_limited' ? 'cloud_rate_limited' : rejected === 'message_too_big' ? 'cloud_invalid_request' : 'cloud_unavailable', 'response')
}

/** The Workflow fast path and existing safety sweep share one fenced receipt lease. */
export async function checkPhonePushReceipts(id: string, _final: boolean): Promise<boolean> {
  const leaseId = randomUUID()
  const { rows: [row] } = await pool.query<{ user_id: string; provider: 'expo' | 'cloud'; secret: Sealed; created_at: Date; check_count: number }>(`UPDATE mobile_push_receipts SET lease_id=$2,lease_until=now()+interval '2 minutes'
    WHERE id=$1 AND (next_check_at<=now() OR created_at<=now()-interval '1 day') AND (lease_until IS NULL OR lease_until<=now())
    RETURNING user_id,provider,secret,created_at,check_count`, [id, leaseId])
  if (!row) return false
  const forget = () => pool.query('DELETE FROM mobile_push_receipts WHERE id=$1 AND lease_id=$2', [id, leaseId])
  try {
    if (row.created_at.getTime() <= Date.now() - 86400_000) { await forget(); return false }
    const tickets = JSON.parse(openSecret(row.secret, aad(id))) as Receipt[]
    let invalidIds: string[], pendingIds: string[], failures: { id: string; code: FailureCode }[]
    if (row.provider === 'cloud') {
      let result: Record<string, unknown>
      try { result = await readCloudJson(await cloudRequest(row.user_id, 'push', '/v1/push/receipts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tickets: tickets.map(({ id, proof }) => ({ id, proof })) }) })) }
      catch (error) {
        // A receipt proof is bound to its original credential. A personal/team
        // switch or revocation ends that lookup; never try another identity.
        if (error instanceof CloudServiceError && ['cloud_not_connected', 'cloud_server_revoked', 'cloud_scope_missing', 'cloud_invalid_request', 'cloud_access_denied'].includes(error.code)) { await forget(); return false }
        throw error
      }
      const failed = result.failures ?? []
      if (!Array.isArray(result.invalidIds) || !Array.isArray(result.pendingIds) || !Array.isArray(failed)
        || [...result.invalidIds, ...result.pendingIds].some(value => typeof value !== 'string' || !tickets.some(t => t.id === value))
        || failed.some(item => !object(item) || !knownFailure(item.code) || typeof item.id !== 'string' || !tickets.some(t => t.id === item.id))) throw new CloudServiceError('cloud_unavailable', 'protocol')
      invalidIds = result.invalidIds as string[]; pendingIds = result.pendingIds as string[]; failures = failed as typeof failures
    } else {
      const result = await expo('getReceipts', { ids: tickets.map(t => t.id) })
      if (!object(result.data)) throw new CloudServiceError('cloud_unavailable', 'protocol')
      invalidIds = []; pendingIds = []; failures = []
      for (const ticket of tickets) {
        const receipt = result.data[ticket.id]
        if (receipt === undefined) { pendingIds.push(ticket.id); continue }
        if (!object(receipt) || !['ok', 'error'].includes(String(receipt.status))) throw new CloudServiceError('cloud_unavailable', 'protocol')
        if (receipt.status === 'error' && object(receipt.details) && receipt.details.error === 'DeviceNotRegistered') invalidIds.push(ticket.id)
        else if (receipt.status === 'error') failures.push({ id: ticket.id, code: failureCode(object(receipt.details) ? receipt.details.error : undefined) })
      }
    }
    await removeTokens(row.user_id, tickets.filter(t => invalidIds.includes(t.id)).map(t => t.token))
    if (failures.length) console.error('phone_push_receipt_rejected', { count: failures.length, codes: [...new Set(failures.map(failure => failure.code))] })
    // The persisted count is authoritative even if a Workflow was replaced or
    // its first check was completed by the recovery sweep. _final is retained
    // for already-started Workflow arguments across this deployment.
    if (row.check_count >= 1 || !pendingIds.length) { await forget(); return false }
    const result = await pool.query(`UPDATE mobile_push_receipts SET secret=$3,check_count=check_count+1,next_check_at=now()+interval '45 minutes',lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2`, [id, leaseId, sealSecret(JSON.stringify(tickets.filter(t => pendingIds.includes(t.id))), aad(id))])
    return result.rowCount === 1
  } catch (cause) {
    try { await pool.query("UPDATE mobile_push_receipts SET next_check_at=now()+interval '2 minutes',lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2", [id, leaseId]) }
    catch (releaseCause) { throw new AggregateError([cause, releaseCause], 'Push receipt retry could not be scheduled') }
    throw cause
  }
}

/** Bounded recovery from the existing 15-minute safety sweep; never sends a push. */
export async function recoverPhonePushReceipts(limit = 20) {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM mobile_push_receipts
    WHERE (next_check_at<=now() OR created_at<=now()-interval '1 day') AND (lease_until IS NULL OR lease_until<=now())
    ORDER BY next_check_at LIMIT $1`, [Math.max(1, Math.min(100, Math.trunc(limit)))])
  let pending = 0, failed = 0
  for (const row of rows) {
    try { if (await checkPhonePushReceipts(row.id, false)) pending++ }
    catch { failed++ }
  }
  if (failed) console.error('phone_push_receipts_recovery_failed', { count: failed, code: 'receipt_unavailable' })
  return { scanned: rows.length, pending, failed }
}
