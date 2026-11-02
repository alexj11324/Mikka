import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'

const calls: unknown[][] = []
let owner: string | null = 'owner'
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../api-auth.ts', { auth: { api: { getSession: async () => owner ? { user: { id: owner } } : null } } })
stub('../request-log.ts', { noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler })
stub('./runtime.ts', { personalPlugins: {
  listMcp: async (userId: string) => { calls.push(['listMcp', userId]); return [] },
  createMcp: async (...args: unknown[]) => { calls.push(['createMcp', ...args]); return { id: randomUUID(), authKind: 'header' } },
  updateMcp: async (...args: unknown[]) => { calls.push(['updateMcp', ...args]); return {} },
  deleteMcp: async (...args: unknown[]) => { calls.push(['deleteMcp', ...args]) },
  listSkills: async (userId: string) => { calls.push(['listSkills', userId]); return [] },
  installSkill: async (...args: unknown[]) => { calls.push(['installSkill', ...args]); return {} },
  updateSkill: async (...args: unknown[]) => { calls.push(['updateSkill', ...args]); return {} },
  deleteSkill: async (...args: unknown[]) => { calls.push(['deleteSkill', ...args]) },
} })
stub('./skill-source.ts', { fetchSkillSource: async (input: unknown) => ({ ...input as object, body: '# Fixture' }) })
stub('../composio.ts', { getComposio: () => ({}) })
stub('./catalog.ts', { composioToolkitLister: () => async () => ({ items: [] }), listStoreCatalog: async () => ({ apps: [{ id: 'googledrive' }], popular: ['googledrive'], latest: [], categories: [] }) })
stub('./app-detail.ts', { composioAppDetailSource: () => ({}), readAppDetail: async (_source: unknown, slug: string) => ({ id: slug, name: 'Supabase', description: 'Postgres', iconUrl: null, categories: [], website: null, version: null, auth: { kind: 'managed', forms: [], guideUrl: null }, tools: { write: [], read: [{ slug: 'SUPABASE_LIST_TABLES', name: 'List tables', description: '' }] } }) })
// The key route with Composio faked at its edge: the form, the auth config, the new account and whose accounts are whose.
// A made-up value, not a key: only its presence in output is checked.
const SECRET = ['submitted', 'credential', 'value'].join('-')
const keyCalls: unknown[][] = []
let initiateFails = false
stub('./credential-connect-server.ts', { credentialConnectDeps: () => ({
  form: async (toolkit: string, scheme: string) => toolkit === 'exa' && scheme === 'API_KEY'
    ? { scheme, fields: [{ name: 'generic_api_key', label: 'API Key', description: '', secret: true, required: true, defaultValue: null }, { name: 'full', label: 'Base URL', description: '', secret: false, required: false, defaultValue: 'https://api.exa.ai' }] }
    : null,
  authConfig: async (toolkit: string, scheme: string) => { keyCalls.push(['authConfig', toolkit, scheme]); return 'ac_mikka_exa' },
  initiate: async (...args: unknown[]) => {
    keyCalls.push(['initiate', ...args])
    // Composio's error may quote what was sent; it must not reach the person or the logs.
    if (initiateFails) throw new Error(`rejected ${SECRET}`)
    return { id: 'ca_new', status: 'ACTIVE' }
  },
  ownAccount: async (userId: string, accountId: string) => userId === 'owner' && accountId === 'ca_owner' ? { id: accountId } : null,
  replace: async (...args: unknown[]) => { keyCalls.push(['replace', ...args]) },
}) })
let credentials: typeof import('../../app/api/integrations/composio/credentials/route')
before(async () => { credentials = await import('../../app/api/integrations/composio/credentials/route') })
let appDetail: typeof import('../../app/api/integrations/composio/catalog/[toolkit]/route')
before(async () => { appDetail = await import('../../app/api/integrations/composio/catalog/[toolkit]/route') })
let mcp: typeof import('../../app/api/integrations/mcp/route'), skills: typeof import('../../app/api/skills/route'), catalog: typeof import('../../app/api/integrations/composio/catalog/route')
before(async () => { mcp = await import('../../app/api/integrations/mcp/route'); skills = await import('../../app/api/skills/route'); catalog = await import('../../app/api/integrations/composio/catalog/route') })
function request(path: string, method = 'GET', data?: unknown, origin = 'https://mikka.acme.dev') {
  return new Request(`https://mikka.acme.dev${path}`, { method, headers: { origin, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
}
test('actual routes require authentication and same-origin mutations before storage/source access', async () => {
  owner = null; calls.length = 0
  for (const handler of [mcp.GET, skills.GET, catalog.GET]) assert.equal((await handler(request('/api/skills'))).status, 401)
  owner = 'owner'
  for (const handler of [mcp.POST, mcp.PATCH, mcp.DELETE, skills.POST, skills.PATCH, skills.DELETE]) assert.equal((await handler(request('/api/skills', 'POST', {}, 'https://evil.acme.dev'))).status, 403)
  assert.deepEqual(calls, [])
})
test('actual routes use the authenticated owner, reject injected owners and expose counts without credentials', async () => {
  owner = 'owner'; calls.length = 0
  assert.deepEqual(await (await mcp.GET(request('/api/integrations/mcp'))).json(), { servers: [], count: 0 })
  assert.deepEqual(await (await skills.GET(request('/api/skills'))).json(), { skills: [], count: 0, scope: 'personal' })
  const input = { name: 'MCP', url: 'https://mcp.acme.dev', auth: { name: 'Authorization', value: 'synthetic-secret' } }
  assert.equal((await mcp.POST(request('/api/integrations/mcp', 'POST', { ...input, userId: 'peer' }))).status, 400)
  const response = await mcp.POST(request('/api/integrations/mcp', 'POST', input))
  assert.equal(response.status, 201); assert.ok(!(await response.text()).includes(input.auth.value))
  assert.equal(calls.at(-1)?.[1], 'owner')
  assert.equal((await skills.POST(request('/api/skills', 'POST', { source: 'owner/repo', slug: 'example' }))).status, 201)
  assert.equal(calls.at(-1)?.[1], 'owner')
  const store = await catalog.GET(request('/api/integrations/composio/catalog'))
  assert.equal(store.status, 200)
  assert.deepEqual(await store.json(), { configured: true, apps: [{ id: 'googledrive' }], popular: ['googledrive'], latest: [], categories: [] })
  const oversized = request('/api/skills', 'POST', { source: 'x'.repeat(17_000), slug: 'x' })
  assert.equal((await skills.POST(oversized)).status, 413)
})

test('an app page needs a signed-in person, not a connected account', async () => {
  const params = { params: Promise.resolve({ toolkit: 'supabase' }) }
  owner = null
  assert.equal((await appDetail.GET(request('/api/integrations/composio/catalog/supabase'), params)).status, 401)
  owner = 'owner'
  const response = await appDetail.GET(request('/api/integrations/composio/catalog/supabase'), params)
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { tools: { read: unknown[] } }).tools.read.length, 1)
})

test('a key goes from the signed-in person to Composio and never back out, in a response or a log', async () => {
  const printed: string[] = []
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const original = methods.map(method => console[method])
  for (const method of methods) console[method] = (...args: unknown[]) => { printed.push(args.map(arg => arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')) }
  try {
    const body = { toolkit: 'exa', scheme: 'API_KEY', fields: { generic_api_key: SECRET } }
    const path = '/api/integrations/composio/credentials'
    owner = null; keyCalls.length = 0
    assert.equal((await credentials.POST(request(path, 'POST', body))).status, 401)
    owner = 'owner'
    assert.equal((await credentials.POST(request(path, 'POST', body, 'https://evil.acme.dev'))).status, 403)
    assert.deepEqual(keyCalls, [])

    const responses: { status: number; text: string }[] = []
    const send = async (data: unknown) => { const response = await credentials.POST(request(path, 'POST', data)); const result = { status: response.status, text: await response.text() }; responses.push(result); return result }
    // Connected for the signed-in person, with Composio's default where nothing was typed; only the account id comes back.
    const ok = await send(body)
    assert.equal(ok.status, 201)
    assert.deepEqual(JSON.parse(ok.text), { accountId: 'ca_new' })
    assert.deepEqual(keyCalls, [['authConfig', 'exa', 'API_KEY'], ['initiate', 'owner', 'ac_mikka_exa', 'API_KEY', { generic_api_key: SECRET, full: 'https://api.exa.ai' }]])
    keyCalls.length = 0
    // Someone else's id in the body, a field Composio does not define, a missing key, an app that does not take a key.
    assert.equal((await send({ ...body, userId: 'peer' })).status, 400)
    assert.equal((await send({ ...body, fields: { generic_api_key: SECRET, extra: 'x' } })).status, 400)
    assert.equal((await send({ ...body, fields: { full: 'https://api.exa.ai' } })).status, 400)
    assert.equal((await send({ ...body, toolkit: 'gmail' })).status, 400)
    assert.equal((await send({ ...body, scheme: 'OAUTH2' })).status, 400)
    // Another person's account cannot be replaced, nor its existence learned.
    assert.equal((await send({ ...body, replaceAccountId: 'ca_peer' })).status, 404)
    assert.deepEqual(keyCalls, [])
    // A new key for one's own account retires the old one.
    assert.equal((await send({ ...body, replaceAccountId: 'ca_owner' })).status, 201)
    assert.deepEqual(keyCalls.at(-1), ['replace', 'owner', 'ca_new', 'ca_owner'])
    // Composio refusing it, with the key in its message.
    initiateFails = true
    const failed = await send(body)
    assert.equal(failed.status, 502)
    assert.deepEqual(JSON.parse(failed.text), { error: 'integrationConnectFailed' })
    for (const response of responses) assert.ok(!response.text.includes(SECRET), response.text)
    assert.ok(printed.every(line => !line.includes(SECRET)), printed.join('\n'))
  } finally {
    initiateFails = false
    methods.forEach((method, index) => { console[method] = original[index] })
  }
})
