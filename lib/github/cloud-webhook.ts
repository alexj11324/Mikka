import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'

export function verifyCloudGitHubSignature(body: string, signature: string | null, secret: string, now = Date.now()): boolean {
  const match = /^t=([1-9]\d{9}),v1=([a-f0-9]{64})$/.exec(signature ?? '')
  if (!match || !secret || Math.abs(Math.floor(now / 1000) - Number(match[1])) > 300) return false
  const expected = createHmac('sha256', secret).update(`${match[1]}.${body}`).digest()
  return timingSafeEqual(expected, Buffer.from(match[2], 'hex'))
}

/** A shared DB lease deduplicates replicas and permits retries after process death.
 * Only the digest and delivery metadata are stored; never the webhook body. */
export function createCloudGitHubReceiver(deps: {
  database: Pick<Pool, 'query'>
  registration(): Promise<{ serverSecret: string } | null>
  readBody(request: Request): Promise<string | null>
  dispatch(event: string, rawBody: string): Promise<Response>
  now?: () => number
}) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' }
    const reply = (status: number) => new Response(null, { status, headers })
    const registration = await deps.registration()
    if (!registration) return reply(401)
    const body = await deps.readBody(request)
    if (body === null) return reply(413)
    const now = deps.now?.() ?? Date.now()
    if (!verifyCloudGitHubSignature(body, request.headers.get('Mikka-Cloud-Signature'), registration.serverSecret, now)) return reply(401)
    const delivery = request.headers.get('x-github-delivery') ?? '', event = request.headers.get('x-github-event') ?? ''
    if (!/^[A-Za-z0-9-]{1,100}$/.test(delivery) || !/^[a-z_]{1,100}$/.test(event)) return reply(400)
    const hash = createHash('sha256').update(body).digest('hex')
    const claimed = await deps.database.query(`INSERT INTO cloud_github_webhook_receipts(delivery_id,event,body_hash,lease_until) VALUES($1,$2,$3,$4)
      ON CONFLICT(delivery_id) DO UPDATE SET lease_until=EXCLUDED.lease_until
      WHERE cloud_github_webhook_receipts.completed_at IS NULL AND cloud_github_webhook_receipts.lease_until<=$5
        AND cloud_github_webhook_receipts.body_hash=EXCLUDED.body_hash AND cloud_github_webhook_receipts.event=EXCLUDED.event RETURNING delivery_id`,
      [delivery, event, hash, new Date(now + 120_000), new Date(now)])
    if (!claimed.rowCount) {
      const { rows: [row] } = await deps.database.query<{ completed_at: Date | null; body_hash: string; event: string }>('SELECT completed_at,body_hash,event FROM cloud_github_webhook_receipts WHERE delivery_id=$1', [delivery])
      return reply(row?.completed_at && row.body_hash === hash && row.event === event ? 204 : 409)
    }
    try {
      const response = await deps.dispatch(event, body)
      if (response.status >= 400) {
        await deps.database.query('UPDATE cloud_github_webhook_receipts SET lease_until=$2 WHERE delivery_id=$1 AND completed_at IS NULL', [delivery, new Date(now)])
        return reply(response.status)
      }
      await deps.database.query('UPDATE cloud_github_webhook_receipts SET completed_at=$2 WHERE delivery_id=$1', [delivery, new Date(deps.now?.() ?? Date.now())])
      return reply(response.status)
    } catch (error) {
      await deps.database.query('UPDATE cloud_github_webhook_receipts SET lease_until=$2 WHERE delivery_id=$1 AND completed_at IS NULL', [delivery, new Date(now)])
      throw error
    }
  }
}
