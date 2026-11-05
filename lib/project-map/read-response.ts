import { createHash } from 'node:crypto'

/** Private responses carry an opaque representation version for the existing
 * live reconnect reconciliation. Authorization is still checked on every read. */
export function mapReadReply(body: unknown, status = 200) {
  const text = JSON.stringify(body)
  return new Response(text, { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
    ...(status === 200 ? { ETag: '"' + createHash('sha256').update(text).digest('hex') + '"' } : {}),
  } })
}
