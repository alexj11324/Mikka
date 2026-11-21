// Loopback substitutes for the guarded local development environment.
// Model serialization belongs exclusively to tests/fakes/litellm.mjs.
import { randomUUID } from 'node:crypto'
import { createLiteLlmRoutes, FAKE_LITELLM_KEY } from '../../tests/fakes/litellm.mjs'
import { localModelAnswer, localDecision } from './model.mjs'
export { localModelAnswer, localDecision } from './model.mjs'
import { MVP_SERVICES } from '../../tests/mvp/isolated-env.mjs'

/** The placeholder for RESEND_API_KEY when the developer set none. Not a credential. */
export const LOCAL_RESEND_KEY = 'mikka-local-outbox'
/** The placeholder LiteLLM service and key; never a live model credential. */
export const LOCAL_LITELLM_KEY = FAKE_LITELLM_KEY
export const LOCAL_LITELLM_URL = `${MVP_SERVICES}/litellm`
/** The placeholder for CRON_SECRET when the developer set none. Not a credential. */
export const LOCAL_CRON_SECRET = 'mikka-local-cron'
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

/**
 * Every local workspace without one gets the card verification and allowance a
 * real workspace gets from Stripe, so Mikka 默认 runs. Returns how many.
 */
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

/**
 * The `routes` hook for startMvpServices: answers its own paths and returns
 * true, or returns false for the fake GitHub and the MVP routes.
 */
export function localServiceRoutes({ log = console.info, origin = 'http://127.0.0.1:3191', observe = () => {} } = {}) {
  const outbox = []
  const modelRoutes = createLiteLlmRoutes({ answer: localModelAnswer, decision: localDecision, observe })
  const routes = async (request, response, url) => {
    const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return true }
    const bearer = request.headers.authorization?.replace(/^Bearer /, '')
    try {
      if (url.pathname === '/mail.json') return json({ messages: outbox })
      if (url.pathname === '/mail') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        const rows = outbox.toReversed().map(mail => `<article><h2>${escape(mail.subject)}</h2><p>${escape(mail.at)} → ${escape(mail.to.join(', '))}</p><pre>${escape(mail.text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</pre></article>`)
        response.end(`<!doctype html><meta charset="utf-8"><title>Local outbox</title><body style="font:14px system-ui;max-width:860px;margin:24px auto;padding:0 16px">${rows.join('') || '<p>Empty</p>'}</body>`)
        return true
      }
      if (url.pathname === '/resend/emails' && request.method === 'POST') {
        if (bearer !== LOCAL_RESEND_KEY) return json({ message: 'unknown key' }, 401)
        const body = await readJson(request)
        const mail = { id: randomUUID(), at: new Date().toISOString(), from: body.from, to: [body.to].flat(), subject: body.subject ?? '', text: body.text ?? body.html ?? '' }
        outbox.push(mail)
        log(`mail "${mail.subject}" to ${mail.to.join(', ')}: ${origin}/mail`)
        return json({ id: mail.id })
      }
      return modelRoutes(request, response, url)
    } catch (error) {
      return json({ error: { message: error.message, type: 'local_services_error' } }, 500)
    }
  }
  return { routes, outbox }
}
