// Loopback substitutes for the cloud services development mode needs
// (docs/dev-workflow.md § 12). Started by scripts/dev-preview.mjs in local
// test-account mode; `node scripts/dev/local-services.mjs` runs it alone.
//
//   /gateway/v*/ai/language-model  Vercel AI Gateway model (scripted, no LLM)
//   /gateway/v1/decisions          AI Gateway Decision API (first choice / 0.5)
//   /resend/emails                 Resend send-email → local outbox
//   /mail, /mail.json              the outbox
//
// It also grants every local workspace the card verification and free
// allowance a real workspace gets from Stripe, so Mikka 默认 runs.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { localDatabaseTarget } from '../test-accounts/database-target.mjs'
import { LOCAL_GATEWAY_KEY, LOCAL_RESEND_KEY, localServicesEnabled, localServicesOrigin } from './local-mode.mjs'

const MAX_BODY = 16 * 1024 * 1024
const LOCAL_ALLOWANCE_MICRO_USD = 1_000_000_000 // $1000 of local, unbilled credit

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request too large')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

const textOf = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')

const usage = () => ({ inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } })
const gatewayMetadata = () => ({ gateway: { generationId: `local-${randomUUID()}`, cost: '0' } })

/**
 * A scripted model. A user message `/tool <name> <json>` calls that registered
 * tool; a tool result is reported back as JSON; anything else is echoed.
 */
export function localModelAnswer(request) {
  const prompt = request.prompt ?? []
  const last = prompt.at(-1)
  if (last?.role === 'tool') {
    const results = (last.content ?? []).filter(part => part.type === 'tool-result')
    const summary = results.map(part => `${part.toolName}: ${JSON.stringify(part.output?.value ?? part.output ?? null).slice(0, 2000)}`).join('\n')
    return { content: [{ type: 'text', text: summary || 'ok' }], finishReason: 'stop' }
  }
  const text = textOf(prompt.findLast(message => message.role === 'user')).trim()
  const command = /^\/tool\s+([\w.-]+)\s*([\s\S]*)$/.exec(text.split('\n').findLast(line => line.startsWith('/tool ')) ?? '')
  if (command) {
    const [, toolName, raw] = command
    if (!request.tools?.some(tool => tool.name === toolName))
      return { content: [{ type: 'text', text: `Local model: no tool named ${toolName}. Tools: ${(request.tools ?? []).map(tool => tool.name).join(', ')}` }], finishReason: 'stop' }
    let input
    try { input = raw.trim() ? JSON.parse(raw) : {} } catch { return { content: [{ type: 'text', text: 'Local model: the tool input is not JSON.' }], finishReason: 'stop' } }
    return { content: [{ type: 'tool-call', toolCallId: `local-${randomUUID()}`, toolName, input: JSON.stringify(input) }], finishReason: 'tool-calls' }
  }
  return { content: [{ type: 'text', text: `Local model: ${text || '(empty)'}` }], finishReason: 'stop' }
}

function generateResult(answer) {
  return { content: answer.content, finishReason: { unified: answer.finishReason, raw: answer.finishReason }, usage: usage(), providerMetadata: gatewayMetadata(), warnings: [] }
}

/** LanguageModelV4 stream parts as the gateway sends them (server-sent events). */
export function streamParts(answer, modelId) {
  const parts = [{ type: 'stream-start', warnings: [] }, { type: 'response-metadata', id: `local-${randomUUID()}`, modelId, timestamp: new Date().toISOString() }]
  for (const [index, part] of answer.content.entries()) {
    if (part.type === 'text') {
      const id = `text-${index}`
      parts.push({ type: 'text-start', id })
      for (const delta of part.text.match(/[\s\S]{1,24}/g) ?? ['']) parts.push({ type: 'text-delta', id, delta })
      parts.push({ type: 'text-end', id })
    } else parts.push(part)
  }
  parts.push({ type: 'finish', finishReason: { unified: answer.finishReason, raw: answer.finishReason }, usage: usage(), providerMetadata: gatewayMetadata() })
  return parts
}

/** Decision API answers: the first choice, or probability 0.5. */
export function localDecision(input) {
  return {
    model: input.model,
    provider_metadata: gatewayMetadata(),
    answers: (input.questions ?? []).map(question => question.type === 'choice'
      ? { type: 'choice', name: question.name, choice: question.choices?.[0]?.value }
      : { type: 'predicate', name: question.name, probability: 0.5 }),
  }
}

/** Every local workspace without one gets a verification and the local allowance. Returns how many. */
export async function grantLocalCredits(appPool, workspacePool = appPool) {
  const { rows } = await workspacePool.query('SELECT id FROM mikka_workspaces')
  if (!rows.length) return 0
  const ids = rows.map(row => row.id)
  const granted = await appPool.query(
    `INSERT INTO hosted_verifications ("workspaceId") SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING RETURNING "workspaceId"`, [ids])
  await appPool.query(
    `INSERT INTO hosted_allowances ("workspaceId", remaining) SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING`, [ids, LOCAL_ALLOWANCE_MICRO_USD])
  return granted.rowCount
}

const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

export async function startLocalServices({ env = process.env, log = console.info, creditsEveryMs = 2000, credits = true } = {}) {
  if (!localServicesEnabled(env)) throw new Error('Local services require local test-account mode (MIKKA_LOCAL_TEST_ACCOUNTS=1, loopback *_e2e databases) outside production')
  const origin = localServicesOrigin(env)
  const outbox = []
  // Both targets were checked by localTestAccountsMode; check again before connecting.
  const appUrl = env.MIKKA_DATABASE_URL || env.E2E_DATABASE_URL
  const workspaceUrl = env.DATABASE_URL || appUrl
  localDatabaseTarget(appUrl); localDatabaseTarget(workspaceUrl)
  const appPool = new pg.Pool({ connectionString: appUrl, max: 1 })
  const workspacePool = workspaceUrl === appUrl ? appPool : new pg.Pool({ connectionString: workspaceUrl, max: 1 })
  let creditError = ''
  const grant = async () => {
    try {
      const count = await grantLocalCredits(appPool, workspacePool)
      if (count) log(`[local-services] granted local credit to ${count} workspace(s)`)
      creditError = ''
    } catch (error) {
      // Tables appear after migrations; report a changed error once.
      if (error.message !== creditError) log(`[local-services] credit grant skipped: ${error.message}`)
      creditError = error.message
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, origin)
    const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    const bearer = request.headers.authorization?.replace(/^Bearer /, '')
    try {
      if (url.pathname === '/health') return json({ ready: true })
      if (url.pathname === '/mail.json') return json({ messages: outbox })
      if (url.pathname === '/mail') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        const rows = outbox.toReversed().map(mail => `<article><h2>${escape(mail.subject)}</h2><p>${escape(mail.at)} → ${escape(mail.to.join(', '))}</p><pre>${escape(mail.text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</pre></article>`)
        return response.end(`<!doctype html><meta charset="utf-8"><title>Local outbox</title><body style="font:14px system-ui;max-width:860px;margin:24px auto;padding:0 16px">${rows.join('') || '<p>Empty</p>'}</body>`)
      }
      if (url.pathname === '/resend/emails' && request.method === 'POST') {
        if (bearer !== LOCAL_RESEND_KEY) return json({ message: 'unknown key' }, 401)
        const body = await readJson(request)
        const mail = { id: randomUUID(), at: new Date().toISOString(), from: body.from, to: [body.to].flat(), subject: body.subject ?? '', text: body.text ?? body.html ?? '' }
        outbox.push(mail)
        log(`[local-services] mail "${mail.subject}" to ${mail.to.join(', ')}: ${origin}/mail`)
        return json({ id: mail.id })
      }
      if (url.pathname.startsWith('/gateway/')) {
        if (bearer !== LOCAL_GATEWAY_KEY) return json({ error: { message: 'unknown key', type: 'authentication_error' } }, 401)
        const path = url.pathname.slice('/gateway'.length)
        if (/^\/v\d+\/ai\/config$/.test(path)) return json({ models: [] })
        if (/^\/v\d+\/ai\/language-model$/.test(path) && request.method === 'POST') {
          const answer = localModelAnswer(await readJson(request))
          const modelId = request.headers['ai-language-model-id'] ?? 'local'
          if (request.headers['ai-language-model-streaming'] !== 'true') return json(generateResult(answer))
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          for (const part of streamParts(answer, modelId)) response.write(`data: ${JSON.stringify(part)}\n\n`)
          return response.end()
        }
        if (path === '/v1/decisions' && request.method === 'POST') return json(localDecision(await readJson(request)))
        return json({ error: { message: `No local substitute for ${path}`, type: 'not_found' } }, 404)
      }
      json({ message: 'not found' }, 404)
    } catch (error) {
      json({ error: { message: error.message, type: 'local_services_error' } }, 500)
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(new URL(origin).port), '127.0.0.1', resolve) })
  if (credits) await grant()
  const timer = credits && creditsEveryMs ? setInterval(grant, creditsEveryMs) : null
  timer?.unref()
  log(`[local-services] ${origin} (model, decisions, mail: ${origin}/mail)`)
  return {
    origin, outbox, grant,
    async close() {
      if (timer) clearInterval(timer)
      await new Promise(resolve => server.close(resolve))
      await appPool.end()
      if (workspacePool !== appPool) await workspacePool.end()
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const services = await startLocalServices()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void services.close().then(() => process.exit(0)) })
}
