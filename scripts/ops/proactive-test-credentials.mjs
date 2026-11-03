import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'

const origin = 'https://app.aspectlylabs.com'
const allowedActions = ['createApiKey', 'deleteApiKey']

/** Read the public client references for this deployment. This is the same
 * authenticated server action used by Settings, with all of its fresh-session
 * and provider checks. Never invent an action ID or bypass Settings with SQL. */
export async function publicCredentialActions(fetchImpl = fetch) {
  const response = await fetchImpl(`${origin}/mikka/en`, { redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw Error('acceptance_action_page_unavailable')
  const html = await response.text()
  const queue = [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.js(?:\?[^"]*)?)"/g)].map(match => new URL(match[1], origin)).filter(url => url.origin === origin && url.pathname.startsWith('/mikka/_next/static/chunks/')).map(url => url.pathname))]
  const seen = new Set(), actions = {}
  while (queue.length && seen.size < 200 && allowedActions.some(name => !actions[name])) {
    const batch = queue.splice(0, 20).filter(path => !seen.has(path))
    for (const path of batch) seen.add(path)
    await Promise.all(batch.map(async path => {
      const result = await fetchImpl(origin + path, { redirect: 'error', signal: AbortSignal.timeout(30000) })
      if (!result.ok) return
      const source = await result.text()
      if (source.length > 8_000_000) throw Error('acceptance_action_asset_oversized')
      for (const match of source.matchAll(/createServerReference\)\("([a-f0-9]{40,64})",[^;]{0,140}?"(createApiKey|deleteApiKey)"\)/g)) actions[match[2]] = match[1]
      for (const match of source.matchAll(/static\/chunks\/[a-zA-Z0-9_.-]+\.js/g)) {
        const next = '/mikka/_next/' + match[0]
        if (!seen.has(next) && !queue.includes(next) && queue.length < 3000) queue.push(next)
      }
    }))
  }
  if (allowedActions.some(name => !actions[name])) throw Error('acceptance_action_reference_missing')
  return actions
}

/** A temporary test key is added only to the existing smoke identity, only if
 * it has no DeepSeek key. Existing keys and all main-account keys are preserved.
 * Credentials/cookies and upstream bodies remain in memory. */
export async function withTemporaryFlashCredential(run, { env = process.env, fetchImpl = fetch, discover = publicCredentialActions } = {}) {
  const email = env.MIKKA_TEST_ACCOUNT_EMAIL ?? env.SMOKE_OWNER_EMAIL
  const password = env.MIKKA_TEST_ACCOUNT_PASSWORD ?? env.SMOKE_OWNER_PASSWORD
  if ((!isSmokeAccountEmail(email) && email !== 'alexjiang20232024@gmail.com') || !password) throw Error('acceptance_account_required')
  let cookie = '', created = null, workspaceId = null
  const cleanup = { created: false, removed: false }
  async function request(path, body, headers = {}) {
    return fetchImpl(origin + '/mikka' + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { origin, 'cache-control': 'no-store', ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  async function json(path, body) { const response = await request(path, body); if (!response.ok) throw Error('acceptance_credential_http_failed'); return response.json() }
  async function action(name, args) {
    const actions = await discover(fetchImpl)
    const response = await request('/en', args, { 'next-action': actions[name], accept: 'text/x-component' })
    if (!response.ok) throw Error('acceptance_credential_action_failed')
    const text = await response.text()
    for (const line of text.split('\n')) {
      if (!/^[0-9a-f]+:\{/.test(line)) continue
      let result
      try { result = JSON.parse(line.slice(line.indexOf(':') + 1)) } catch { continue }
      if (result?.error) throw Error('acceptance_credential_settings_rejected')
      if (name === 'createApiKey' && typeof result?.id === 'string' && result.provider === 'deepseek') return result
      if (name === 'deleteApiKey' && result?.removed === true) return result
    }
    throw Error('acceptance_credential_result_missing')
  }
  try {
    const login = await request('/api/auth/sign-in/email', { email, password })
    if (login.status !== 200) throw Error('acceptance_sign_in_failed')
    cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    const session = await json('/api/auth/get-session')
    if (!cookie || session?.user?.email?.toLowerCase() !== email.toLowerCase()) throw Error('acceptance_session_identity')
    const bots = await json('/api/bots')
    workspaceId = bots?.[0]?.workspaceId
    if (typeof workspaceId !== 'string') throw Error('acceptance_workspace_missing')
    const before = await json('/api/settings/api-keys?workspace=' + encodeURIComponent(workspaceId))
    if (!Array.isArray(before?.keys)) throw Error('acceptance_key_inventory_missing')
    if (!before.keys.some(key => key.provider === 'deepseek')) {
      if (!isSmokeAccountEmail(email) || !env.DEEPSEEK_API_KEY) throw Error('acceptance_flash_model_unavailable')
      // Re-read immediately before the Settings write, which would otherwise
      // replace an existing preset. Tests never rotate an existing account key.
      const latest = await json('/api/settings/api-keys?workspace=' + encodeURIComponent(workspaceId))
      if (!Array.isArray(latest?.keys) || latest.keys.some(key => key.provider === 'deepseek')) throw Error('acceptance_key_inventory_changed')
      created = await action('createApiKey', [{ provider: 'deepseek', apiKey: env.DEEPSEEK_API_KEY }, workspaceId])
      cleanup.created = true
    }
    return await run(cleanup)
  } finally {
    try {
      if (created) {
        await action('deleteApiKey', [created.id, workspaceId])
        cleanup.removed = true
      }
    } finally {
      if (cookie) await request('/api/auth/sign-out', {}).catch(() => {})
      cookie = ''
    }
  }
}
