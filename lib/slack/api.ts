// Completion posts go to Slack's Web API directly, not through the Chat SDK:
// only this call carries the metadata that a later retry uses to reconcile an
// uncertain send. The bot token stays in this module's request header and is
// never logged, returned or put in an error.
import { slackConfig } from './config'

export type SlackConfig = NonNullable<ReturnType<typeof slackConfig>>

const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage'
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RETRY_AFTER_MS = 60_000
const DEFAULT_RETRY_AFTER_MS = 1_000

export type SlackSkippedCode =
  | 'channel_not_found'
  | 'is_archived'
  | 'channel_is_archived'
  | 'not_in_channel'
export type SlackFailedCode =
  | 'invalid_auth'
  | 'token_revoked'
  | 'account_inactive'
  | 'invalid_response'
  | 'unknown'

export type SlackPostResult =
  | { status: 'ok'; ts: string }
  | { status: 'skipped'; code: SlackSkippedCode }
  | { status: 'failed'; code: SlackFailedCode }
  | { status: 'retryable'; reason: 'rate_limited'; retryAfterMs: number }
  | { status: 'retryable'; reason: 'server_error' | 'timeout' | 'network' }

const SKIPPED_CODES: readonly SlackSkippedCode[] = ['channel_not_found', 'is_archived', 'channel_is_archived', 'not_in_channel']
const FAILED_CODES: readonly SlackFailedCode[] = ['invalid_auth', 'token_revoked', 'account_inactive']

export interface SlackCompletionPost {
  channel: string
  threadTs: string
  text: string
  runId: string
  linkId: string
}

export interface SlackPostOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

function isTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && ((error as { name?: unknown }).name === 'TimeoutError' || (error as { name?: unknown }).name === 'AbortError')
}

/** Retry-After is seconds; missing or malformed means a short default, capped at one minute. */
function retryAfterMs(value: string | null): number {
  if (value === null) return DEFAULT_RETRY_AFTER_MS
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS
  return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS)
}

async function readBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json()
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Posts one run-finished line to the link's thread. Never throws and never
 * echoes Slack's message text: callers persist the fixed code only.
 */
export async function postSlackCompletion(
  config: SlackConfig,
  post: SlackCompletionPost,
  options: SlackPostOptions = {},
): Promise<SlackPostResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let response: Response
  try {
    response = await fetchImpl(SLACK_POST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: post.channel,
        thread_ts: post.threadTs,
        text: post.text,
        metadata: {
          event_type: 'mikka_run_finished',
          event_payload: { runId: post.runId, linkId: post.linkId },
        },
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return isTimeout(error)
      ? { status: 'retryable', reason: 'timeout' }
      : { status: 'retryable', reason: 'network' }
  }
  // Read once for every status: this also drains the body so a retry does not
  // leave the connection holding an unread response.
  const body = await readBody(response)
  if (response.status === 429) {
    return { status: 'retryable', reason: 'rate_limited', retryAfterMs: retryAfterMs(response.headers.get('retry-after')) }
  }
  if (response.status >= 500) return { status: 'retryable', reason: 'server_error' }
  if (response.ok && body?.ok === true) {
    return typeof body.ts === 'string' && body.ts.length > 0
      ? { status: 'ok', ts: body.ts }
      : { status: 'failed', code: 'invalid_response' }
  }
  const code = typeof body?.error === 'string' ? body.error : ''
  // Slack sometimes returns `ratelimited` with HTTP 200; Retry-After still
  // carries the wait.
  if (code === 'ratelimited') {
    return { status: 'retryable', reason: 'rate_limited', retryAfterMs: retryAfterMs(response.headers.get('retry-after')) }
  }
  if ((SKIPPED_CODES as readonly string[]).includes(code)) return { status: 'skipped', code: code as SlackSkippedCode }
  if ((FAILED_CODES as readonly string[]).includes(code)) return { status: 'failed', code: code as SlackFailedCode }
  return { status: 'failed', code: 'unknown' }
}
