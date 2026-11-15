import { createHash, randomBytes } from 'node:crypto'

/**
 * An automation's webhook URL (decision 2026-11-15-1830): `/api/webhooks/automations/<key>`. The key is the only
 * credential, so it is long, random and kept only as its SHA-256. A request body is data from whoever has the URL,
 * never an instruction from the person; the Bot reads it inside marked blocks.
 */
export const WEBHOOK_MAX_BYTES = 64 * 1024
/** One batched run takes at most this many requests, and this many bytes of them; more start the next run. */
export const WEBHOOK_BATCH_REQUESTS = 50
export const WEBHOOK_BATCH_BYTES = 256 * 1024
export const WEBHOOK_KEY = /^mwh_[A-Za-z0-9_-]{43}$/
const REQUEST_KEY = /^[\x21-\x7e]{1,200}$/

export type WebhookRequest = { at: string; body: string; key?: string }

export function newWebhookKey() { return `mwh_${randomBytes(32).toString('base64url')}` }
export function webhookKeyHash(key: string) { return createHash('sha256').update(key).digest('hex') }

/** The sender's own request ID (`Idempotency-Key`, else `X-Request-Id`): the same one is taken once. */
export function webhookRequestKey(headers: Headers): string | undefined {
  const value = headers.get('idempotency-key') ?? headers.get('x-request-id')
  return value && REQUEST_KEY.test(value) ? value : undefined
}

/** JSON is kept as sent, other text as text; a body that is not UTF-8 text is refused by the caller. */
export function webhookBody(raw: string) { return raw.replace(/\r\n/g, '\n') }

/** The requests a run started on, oldest first, each in its own block the body cannot close. */
export function describeWebhook(requests: readonly WebhookRequest[]): string {
  return requests.map(request => `<webhook_request received_at="${request.at}">\n${request.body.replace(/<\/webhook_request/gi, '<\\/webhook_request')}\n</webhook_request>`).join('\n')
}
