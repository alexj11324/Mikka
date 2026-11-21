import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { Client } from 'eve/client'
import type { ApiConnection } from '../lib/api.ts'
import type { SavedAccount } from '../lib/server-store.ts'

const platform = { OS: 'ios' }
const first: SavedAccount = { id: '1', user: { id: 'owner-a', name: 'A', email: 'a@example.invalid' }, server: {
  url: 'https://alpha.example:8443/mikka', name: 'Alpha', version: null, edition: 'cloud', signIn: { email: true, google: false, github: false, apple: false }, mobileReady: true,
} }
const second: SavedAccount = { ...first, id: '2', server: { ...first.server, url: 'http://127.0.0.1:4100/team/mikka' }, user: { id: 'owner-b', name: 'B', email: 'b@example.invalid' } }
let current = first
const workspaces = new Map([['mikka_account_1_workspace', 'workspace-a'], ['mikka_account_2_workspace', 'workspace-b']])
const turnBodies: { clientContext?: { taskCommand?: { intent?: string } } }[] = []
const requests: { transport: 'expo' | 'browser'; url: string; headers: Headers; credentials: RequestCredentials | undefined }[] = []

function response(transport: 'expo' | 'browser', input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.equal(init?.method, 'POST')
  const headers = new Headers(init?.headers)
  requests.push({ transport, url: url.href, headers, credentials: init?.credentials })
  // The native cookie-authenticated server enforces its canonical Origin on POSTs.
  if (transport === 'expo' && headers.get('origin') !== url.origin) return Response.json({ error: 'authRequired' }, { status: 401 })
  const sessionId = url.hostname === 'alpha.example' ? 'wrun_alpha' : 'wrun_beta'
  const payload = JSON.parse(String(init?.body ?? '{}'))
  if (payload.message !== undefined) turnBodies.push(payload)
  return Response.json({ ok: true, sessionId, ...(payload.message !== undefined ? { deliveryId: 'delivery_fixture' } : {}) })
}
const originalFetch = globalThis.fetch
// The real Eve platform adapter must choose Expo fetch on native and browser fetch on web.
globalThis.fetch = async (input, init) => response('browser', input, init)
mock.module('react-native', { namedExports: { Platform: platform } })
mock.module('expo/fetch', { namedExports: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => response('expo', input, init) } })
mock.module('expo-secure-store', { namedExports: { getItemAsync: async (key: string) => workspaces.get(key) ?? null, setItemAsync: async () => {} } })
mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { authClient: { getCookie: async () => 'better-auth.session_token=fixture-a' } } })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { currentAccount: () => current } })
mock.module(new URL('../lib/session.ts', import.meta.url).href, { namedExports: { endLostSession: async () => {} } })
mock.module(new URL('../lib/tracing.ts', import.meta.url).href, { namedExports: { mobileTraceHeaders: () => ({ 'x-mikka-client': 'mobile' }) } })
const { eveClientOptions } = await import('../lib/eve-client.ts')
after(() => { globalThis.fetch = originalFetch })

test('native public Client default create and send retain the captured server Origin, account cookie and workspace', async () => {
  let releaseCookie!: (cookie: string) => void
  const cookie = new Promise<string>(resolve => { releaseCookie = resolve })
  const connection = { account: first, client: { getCookie: () => cookie } } as unknown as ApiConnection
  const native = new Client(eveClientOptions(null, connection))
  const creation = native.sessions.create()
  current = second
  releaseCookie('better-auth.session_token=fixture-a')
  const { session } = await creation
  await session.send('No network model call: fixture transport only')
  const next = new Client(eveClientOptions(null, { account: second, client: { getCookie: async () => 'better-auth.session_token=fixture-b' } } as unknown as ApiConnection))
  const nextSession = (await next.sessions.create()).session
  await nextSession.send('Second account fixture')
  assert.deepEqual(requests.map(request => ({ transport: request.transport, url: request.url, origin: request.headers.get('origin'), cookie: request.headers.get('cookie'), credentials: request.credentials })), [
    { transport: 'expo', url: 'https://alpha.example:8443/mikka/api/agents/eve/v1/session', origin: 'https://alpha.example:8443', cookie: 'better-auth.session_token=fixture-a; mikka-workspace=workspace-a', credentials: 'omit' },
    { transport: 'expo', url: 'https://alpha.example:8443/mikka/api/agents/eve/v1/session/wrun_alpha', origin: 'https://alpha.example:8443', cookie: 'better-auth.session_token=fixture-a; mikka-workspace=workspace-a', credentials: 'omit' },
    { transport: 'expo', url: 'http://127.0.0.1:4100/team/mikka/api/agents/eve/v1/session', origin: 'http://127.0.0.1:4100', cookie: 'better-auth.session_token=fixture-b; mikka-workspace=workspace-b', credentials: 'omit' },
    { transport: 'expo', url: 'http://127.0.0.1:4100/team/mikka/api/agents/eve/v1/session/wrun_beta', origin: 'http://127.0.0.1:4100', cookie: 'better-auth.session_token=fixture-b; mikka-workspace=workspace-b', credentials: 'omit' },
  ])
})

test('web public Client leaves Origin and cookies to the browser', async () => {
  platform.OS = 'web'
  requests.length = 0
  const browser = new Client(eveClientOptions(null, { account: first, client: { getCookie: async () => assert.fail('browser cookies must not be read manually') } } as unknown as ApiConnection))
  const { session } = await browser.sessions.create()
  await session.send('Web fixture')
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.transport, 'browser')
    assert.equal(request.headers.get('origin'), null)
    assert.equal(request.headers.get('cookie'), null)
    assert.equal(request.credentials, 'include')
  }
})

test('native Task creation uses the shared manual command and re-reads an accepted dispatch without another send', async t => {
  const { submitMobileTask } = await import('../lib/task-create.ts')
  platform.OS = 'ios'
  requests.length = 0
  const prior = globalThis.fetch
  t.after(() => { globalThis.fetch = prior })
  const captured: { action: string; args: Record<string, unknown>[] }[] = []
  globalThis.fetch = async (input, init) => {
    if (!String(input).endsWith('/api/rpc')) return prior(input, init)
    assert.equal(String(input), first.server.url + '/api/rpc')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('x-mikka-rpc'), '1')
    assert.equal(headers.get('origin'), new URL(first.server.url).origin)
    assert.match(headers.get('cookie') ?? '', /fixture-a/)
    const body = JSON.parse(String(init?.body))
    captured.push(body)
    return Response.json({ version: 1, ok: true, result: captured.length === 2 ? null : { taskId: 'task1' } })
  }
  const connection = { account: first, client: { getCookie: async () => 'better-auth.session_token=fixture-a' } } as unknown as ApiConnection
  const draft = { workspaceId: 'workspace-a', description: 'Line one\n\nLine two', title: '' }
  assert.equal(await submitMobileTask({ ...draft, intent: 'create_only' }, { id: 'manual' }, connection), 'task1')
  assert.equal(requests.length, 0)
  assert.equal(captured[0].action, 'issues.createTaskOnly')
  assert.deepEqual(captured[0].args, [{ version: 1, intent: 'create_only', workspaceId: 'workspace-a', requestId: 'manual',
    title: 'Line one', content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }] }, { type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: 'Line two' }] },
    ] }, priority: 'normal', status: 'todo' }])
  const operation = { id: 'stable-dispatch' }
  const dispatch = { ...draft, intent: 'create_and_dispatch' as const }
  await assert.rejects(submitMobileTask(dispatch, operation, connection), /receiptUnavailable/)
  assert.equal(await submitMobileTask(dispatch, operation, connection), 'task1')
  assert.equal(requests.length, 1, 'the initial Eve turn and session use one authorized request')
  assert.equal(requests[0].headers.get('x-mikka-submission-id'), operation.id)
  assert.ok(new URL(requests[0].url).pathname.endsWith('/session'))
  assert.equal(turnBodies.at(-1)?.clientContext?.taskCommand?.intent, 'create_and_dispatch')
  assert.deepEqual(captured.slice(1).map(({ action, args }) => [action, args]), Array(2).fill(['issues.getDispatchedTaskReceipt', [{ workspaceId: 'workspace-a', botId: null, requestId: operation.id }]]))
})
