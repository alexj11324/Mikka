import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WriteProvider } from '../../lib/operations/write-contract'
import type { ComposioActionClient } from '../../lib/composio-actions'

/** An independent loopback effect service. It deliberately does not deduplicate
 * POSTs: a second call would produce a second effect and fail the assertions. */
export function recoveryHttpProvider(origin: string, afterEffect?: () => Promise<never>): WriteProvider {
  const base = new URL(origin)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw Error('loopback effect fixture required')
  return {
    name: 'local-recovery-fixture',
    async prepare() { return { accountId: 'fixture-account', version: 'fixture-v1' } },
    async execute(input) {
      await input.beforeSend()
      const response = await fetch(new URL('/effects', base), { method: 'POST', body: JSON.stringify({ key: input.idempotencyKey }), signal: input.signal })
      if (!response.ok) throw Error('effect fixture rejected request')
      const receipt = await response.json()
      if (afterEffect) await afterEffect()
      return receipt
    },
    async lookup(input) {
      const response = await fetch(new URL(`/effects/${input.idempotencyKey}`, base))
      if (!response.ok) throw Error('effect fixture readback failed')
      return response.json()
    },
  }
}

/** Real product Slack adapter over an independent HTTP protocol fixture. No
 * Composio credentials or SaaS account are used by this fault-injection test. */
export async function recoverySlackProvider(origin: string, afterEffect?: () => Promise<never>): Promise<WriteProvider> {
  const base = new URL(origin)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw Error('loopback effect fixture required')
  const [{ composioWriteProvider }, { composioSlackConversationReader }, { composioSlackDelivery }] = await Promise.all([
    import('../../lib/operations/write-provider'), import('../../lib/operations/slack-conversation-read'), import('../../lib/operations/slack-delivery'),
  ])
  const client = {
    connectedAccounts: { list: async ({ userIds, toolkitSlugs }: { userIds: string[]; toolkitSlugs: string[] }) => ({
      items: userIds.length === 1 && ['owner', 'recovery-owner'].includes(userIds[0]) && toolkitSlugs[0] === 'slack' ? [{ id: 'fixture-slack-account', toolkit: { slug: 'slack' }, status: 'ACTIVE', isDisabled: false }] : [],
    }) },
    // SLACK_SEND_MESSAGE's tags as Composio returned them on 2026-10-31.
    tools: { getRawComposioToolBySlug: async () => ({ version: '00000000_00', tags: ['chat', 'important', 'openWorldHint'] }), proxyExecute: async (request: { endpoint: string; method: string; userId: string; connectedAccountId: string; body?: unknown; parameters?: { in: string; name: string; value: string | number }[] }, options?: { signal?: AbortSignal }) => {
      if (!['owner', 'recovery-owner'].includes(request.userId) || request.connectedAccountId !== 'fixture-slack-account') throw Error('fixture account mismatch')
      const url = new URL(request.endpoint, base)
      for (const parameter of request.parameters ?? []) {
        if (parameter.in !== 'query') throw Error('unexpected fixture parameter')
        url.searchParams.set(parameter.name, String(parameter.value))
      }
      const response = await fetch(url, { method: request.method, ...(request.body ? { body: JSON.stringify(request.body) } : {}), signal: options?.signal })
      const result = { status: response.status, data: await response.json() }
      if (afterEffect && request.endpoint === '/chat.postMessage') await afterEffect()
      return result
    } },
  } as unknown as ComposioActionClient
  return composioWriteProvider(client, 'send_slack_message', undefined, undefined, composioSlackConversationReader(client), composioSlackDelivery(client))
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'server') {
    const effects = new Map<string, { providerObjectId: string; evidenceDigest: string }>()
    const slackMessages: Record<string, unknown>[] = []
    let posts = 0
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      const url = new URL(request.url!, 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/stats') return response.end(JSON.stringify({ posts, effects: effects.size + slackMessages.length }))
      if (request.method === 'GET' && /^\/effects\/[a-f0-9]{64}$/.test(url.pathname)) return response.end(JSON.stringify(effects.get(url.pathname.slice(9)) ?? null))
      if (request.method === 'GET' && url.pathname === '/conversations.info') return response.end(JSON.stringify({ ok: true, channel: { id: url.searchParams.get('channel'), is_member: true, is_archived: false } }))
      if (request.method === 'GET' && url.pathname === '/conversations.history') return response.end(JSON.stringify({ ok: true, messages: slackMessages.filter(message => message.channel === url.searchParams.get('channel')) }))
      if (request.method === 'GET' && url.pathname === '/chat.getPermalink') return response.end(JSON.stringify({ ok: true, channel: url.searchParams.get('channel'), permalink: `https://fixture.slack.com/archives/${url.searchParams.get('channel')}/p${url.searchParams.get('message_ts')!.replace('.', '')}` }))
      if (request.method !== 'POST' || !['/effects', '/chat.postMessage'].includes(url.pathname)) { response.statusCode = 404; return response.end('{}') }
      let body = ''
      for await (const part of request) { body += part; if (body.length > 4096) { response.statusCode = 413; return response.end('{}') } }
      const value = JSON.parse(body)
      if (url.pathname === '/chat.postMessage') {
        if (value.channel !== 'C12345678' || typeof value.text !== 'string' || !/^[a-f0-9]{64}$/.test(value.metadata?.event_payload?.operation_key)) { response.statusCode = 422; return response.end('{}') }
        posts++
        const message = { ...value, ts: `1700000000.${String(posts).padStart(6, '0')}` }
        slackMessages.push(message)
        return response.end(JSON.stringify({ ok: true, channel: value.channel, ts: message.ts, message }))
      }
      if (!/^[a-f0-9]{64}$/.test(value.key)) { response.statusCode = 422; return response.end('{}') }
      posts++
      const providerObjectId = randomUUID()
      const receipt = { providerObjectId, evidenceDigest: createHash('sha256').update(JSON.stringify([value.key, providerObjectId])).digest('hex') }
      effects.set(value.key, receipt)
      response.end(JSON.stringify(receipt))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('effect address unavailable')
    process.send?.({ kind: 'ready', origin: `http://127.0.0.1:${address.port}` })
    return
  }
  if (mode !== 'worker') throw Error('explicit fixture mode required')
  const { validateTarget } = await import('../../scripts/run-db-tests.mjs')
  validateTarget(process.env)
  const schema = process.env.OPERATION_RECOVERY_SCHEMA!
  if (!/^operation208_[a-f0-9]{32}$/.test(schema)) throw Error('invalid owned fixture schema')
  const [{ default: pg }, { createApprovedWrites }] = await Promise.all([
    import('pg'), import('../../lib/operations/approved-writes'),
  ])
  const pool = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, options: `-c search_path=${schema},pg_catalog`, max: 2 })
  try {
    const afterEffect = async () => {
      process.send?.({ kind: 'effect-applied' })
      return new Promise<never>(() => {}) // Parent kills this process before receipt writeback.
    }
    const slack = process.env.OPERATION_RECOVERY_PROVIDER === 'slack'
    const provider = slack ? await recoverySlackProvider(process.env.OPERATION_RECOVERY_ORIGIN!, afterEffect) : recoveryHttpProvider(process.env.OPERATION_RECOVERY_ORIGIN!, afterEffect)
    await createApprovedWrites(pool, provider, slack ? 'send_slack_message' : 'append_notion_paragraph', { modelRun: {
      ownerId: 'recovery-owner', botId: null, workspaceId: null, runId: process.env.OPERATION_RECOVERY_RUN!,
    } }).proposeFromRun({ ...(slack ? { channel: 'C12345678' } : { page_id: process.env.OPERATION_RECOVERY_PAGE! }), text: 'Controlled local recovery effect' }, process.env.OPERATION_RECOVERY_INTENT!)
  } finally { await pool.end() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : 'operation fixture failed'); process.exitCode = 1 })
}
