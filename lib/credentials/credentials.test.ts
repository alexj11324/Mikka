import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { canonicalOrigin, assertSameOrigin, submitSchema, otpSchema, CredentialError, type EncryptionContext } from './contracts'
import { seal, open, sealSession, type Kms } from './kms'
import { checkCredentialRequest, credentialBody, credentialFailure } from './http'
import { Cdp } from './browser'
import { fillCredential } from './broker'
import { CredentialStore } from './store'
import { assertCredentialPageBinding, type CredentialPageBinding } from './page-binding'
import { assertNoSecret, fingerprint } from './fingerprint'

function fixtureKms(): Kms {
  const keys = new Map<string, { key: Buffer; context: string }>()
  return {
    async generate(context) {
      const key = randomBytes(32), wrapped = randomBytes(32).toString('base64')
      keys.set(wrapped, { key: Buffer.from(key), context: JSON.stringify(context) })
      return { plaintext: key, wrapped }
    },
    async decrypt(wrapped, context) {
      const record = keys.get(wrapped)
      if (!record || JSON.stringify(context) !== record.context) throw new CredentialError()
      return Buffer.from(record.key)
    },
  }
}
const owner: EncryptionContext = { userId: 'owner-a', credentialId: 'opaque-random-id', origin: 'https://example.com' }
test('AES-GCM and KMS context isolate owner, credential id, and origin', async () => {
  const kms = fixtureKms(), plaintext = Buffer.from('test-password-never-log')
  const envelope = await seal(kms, owner, plaintext)
  assert(plaintext.every(byte => byte === 0))
  assert.equal((await open(kms, owner, envelope)).toString(), 'test-password-never-log')
  for (const alternate of [{ ...owner, userId: 'owner-b' }, { ...owner, credentialId: 'forged' }, { ...owner, origin: 'https://evil.example' }]) await assert.rejects(open(kms, alternate, envelope))
  await assert.rejects(open(kms, owner, { ...envelope, ciphertext: Buffer.from('tampered').toString('base64') }))
  await assert.rejects(open(kms, owner, { ...envelope, nonce: randomBytes(12).toString('base64') }))
})
test('session ciphertext has distinct AAD and fresh nonce', async () => {
  const kms = fixtureKms(), password = await seal(kms, owner, Buffer.from('password'))
  const session = await sealSession(kms, owner, password.wrappedDek, Buffer.from('cookie-state'))
  assert.notEqual(password.nonce, session.nonce)
  assert.equal((await open(kms, owner, session, 'session')).toString(), 'cookie-state')
  await assert.rejects(open(kms, owner, session))
  await assert.rejects(open(kms, owner, password, 'session'))
})
test('provider failure still clears the plaintext buffer and never returns cause', async () => {
  const buffer = Buffer.from('test-secret')
  await assert.rejects(seal({ ...fixtureKms(), generate: async () => { throw new CredentialError() } }, owner, buffer))
  assert(buffer.every(byte => byte === 0))
  const session = Buffer.from('test-session-cookie')
  await assert.rejects(sealSession({ ...fixtureKms(), decrypt: async () => { throw new CredentialError() } }, owner, 'wrapped', session))
  assert(session.every(byte => byte === 0))
  const failure = credentialFailure(new Error('test-secret'))
  assert.equal(failure.status, 503)
  assert.equal((await failure.text()).includes('test-secret'), false)
})
test('exact HTTPS origin rejects userinfo and IDNA confusables without restricting browsing', () => {
  assert.equal(canonicalOrigin('https://EXAMPLE.com/login'), 'https://example.com')
  assertSameOrigin('https://example.com:443/login', 'https://example.com')
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com.', 'javascript:alert(1)']) assert.throws(() => canonicalOrigin(url))
  for (const url of ['https://example.com.evil.test', 'https://ｅxamplе.com', 'https://example.com:444', 'https://sub.example.com']) assert.throws(() => assertSameOrigin(url, 'https://example.com'))
})
test('submission schema rejects caller-specified user/id, CR LF NUL and excess fields', () => {
  const input = { nonce: 'a'.repeat(43), origin: owner.origin, username: 'test', password: 'test-password' }
  assert(submitSchema.safeParse(input).success)
  for (const additional of [{ userId: 'b' }, { credentialId: 'forged' }, { lease: 'replay' }]) assert(!submitSchema.safeParse({ ...input, ...additional }).success)
  for (const password of ['a\rb', 'a\nb', 'a\0b']) assert(!submitSchema.safeParse({ ...input, password }).success)
})
test('CSRF requires exact origin, dedicated header and non-cross-site metadata', () => {
  const request = (headers: Record<string, string>) => new Request('https://app.example/api/credentials', { method: 'POST', headers })
  checkCredentialRequest(request({ origin: 'https://app.example', 'x-mikka-credential': '1' }))
  const rejected: Record<string, string>[] = [{ origin: 'https://evil.example', 'x-mikka-credential': '1' }, { origin: 'https://app.example' }, { origin: 'https://app.example', 'x-mikka-credential': '1', 'sec-fetch-site': 'cross-site' }]
  for (const headers of rejected) assert.throws(() => checkCredentialRequest(request(headers)))
})
test('actual streaming payload limit applies without content-length', async () => {
  await assert.rejects(credentialBody(new Request('https://app.example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(13000) }) })), (error: unknown) => error instanceof CredentialError && error.status === 413)
  assert.deepEqual(await credentialBody(new Request('https://app.example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })), { ok: true })
})
test('pushState/hash changes cannot resume screenshots while fields remain populated', async () => {
  const cdp = Object.create(Cdp.prototype) as Cdp
  cdp.call = async method => method === 'DOM.getDocument' ? { root: { nodeName: '#document' } } : { frameTree: { frame: { url: 'https://example.com/changed#hash' } } }
  cdp.evaluate = async () => false
  assert.equal(await cdp.safeToResume('https://example.com/login'), false)
  cdp.evaluate = async () => true
  assert.equal(await cdp.safeToResume('https://example.com/login'), true)
})

test('viewer stays locked for every supported nonempty OTP input', async () => {
  const cdp = Object.create(Cdp.prototype) as Cdp
  cdp.call = async method => method === 'DOM.getDocument' ? { root: { nodeName: '#document' } } : { frameTree: {} }
  for (const field of [
    { tagName: 'INPUT', type: 'password', autocomplete: '', name: 'password' },
    { tagName: 'INPUT', type: 'text', autocomplete: 'one-time-code', name: 'verification' },
    { tagName: 'INPUT', type: 'text', autocomplete: '', name: 'code' },
    { tagName: 'INPUT', type: 'text', autocomplete: '', name: 'otp' },
    { tagName: 'INPUT', type: 'text', autocomplete: '', name: 'arbitrary' },
    { tagName: 'TEXTAREA', type: 'textarea', autocomplete: '', name: 'arbitrary' },
  ]) {
    for (const value of ['123456', '']) {
      const input = { ...field, value }
      cdp.evaluate = async expression => runInNewContext(expression, { document: { querySelectorAll: () => [input] } })
      assert.equal(await cdp.safeToResume('https://example.com/login'), value === '', JSON.stringify(field))
    }
  }
  cdp.evaluate = async expression => runInNewContext(expression, { document: { querySelectorAll: () => [{ tagName: 'INPUT', type: 'hidden', value: 'fixed' }] } })
  assert.equal(await cdp.safeToResume('https://example.com/login'), true)
})

test('viewer stays locked when nested documents or author shadow roots cannot be inspected', async () => {
  const cdp = Object.create(Cdp.prototype) as Cdp
  cdp.evaluate = async () => true
  for (const [tree, root, expected] of [
    [{ frameTree: {} }, { nodeName: '#document' }, true],
    [{ frameTree: { childFrames: [{}] } }, { nodeName: '#document' }, false],
    [{ frameTree: { childFrames: {} } }, { nodeName: '#document' }, false],
    [{ frameTree: {} }, { nodeName: '#document', children: [{ nodeName: 'IFRAME' }] }, false],
    [{ frameTree: {} }, { nodeName: '#document', children: [{ shadowRoots: [{ shadowRootType: 'open' }] }] }, false],
    [{ frameTree: {} }, { nodeName: '#document', children: [{ shadowRoots: [{ shadowRootType: 'closed' }] }] }, false],
    [{ frameTree: {} }, { nodeName: '#document', children: [{ shadowRoots: [{ shadowRootType: 'user-agent' }] }] }, true],
    [{}, { nodeName: '#document' }, false],
  ] as const) {
    cdp.call = async method => method === 'DOM.getDocument' ? { root } : tree
    assert.equal(await cdp.safeToResume('https://example.com/login'), expected)
  }
  cdp.call = async () => { throw new Error('CDP unavailable') }
  assert.equal(await cdp.safeToResume('https://example.com/login'), false)
})

test('HMAC scanner rejects nested chat/tool secret copies without retaining values', () => {
  const key = 'unit-test-auth-secret', entry = fingerprint('a', 'test-password', key)
  assert(!JSON.stringify(entry).includes('test-password'))
  assert.throws(() => assertNoSecret('a', { content: [{ text: 'prefix test-password suffix' }] }, [entry], key), CredentialError)
  assertNoSecret('a', { text: 'safe status' }, [entry], key)
  assertNoSecret('b', { text: 'test-password' }, [entry], key)
})

test('verification codes use a separate authenticated envelope purpose', async () => {
  const kms = fixtureKms(), code = await seal(kms, owner, Buffer.from('123456'), 'otp')
  assert.equal((await open(kms, owner, code, 'otp')).toString(), '123456')
  await assert.rejects(open(kms, owner, code))
  assert(otpSchema.safeParse({ nonce: 'a'.repeat(43), origin: owner.origin, code: '123456' }).success)
  assert(!otpSchema.safeParse({ nonce: 'a'.repeat(43), origin: owner.origin, code: '123456', credentialId: 'forged' }).success)
})

function bindFixtureAction(claimed: any) {
  claimed.target.sandboxId = 'synthetic-sandbox'
  const input = claimed.target.observedInput
  const action = { kind: 'browser_credential', actionId: '11111111-1111-4111-8111-111111111111', admission: 'ask', digest: 'a'.repeat(64), summary: 'synthetic', userId: claimed.user_id, workspaceId: claimed.workspace_id, botId: claimed.bot_id, subagentId: claimed.subagent_id, runId: claimed.subagent_id, epoch: input?.epoch ?? 1, policyVersion: input?.permissionVersion ?? 0, targetId: claimed.target.targetId, origin: claimed.origin, loaderId: input?.loaderId ?? 'loader', backendNodeId: input?.backendNodeId ?? 7, role: input?.credentialRole ?? 'password', expiresAt: Date.now() + 60000 }
  claimed.target.credentialAction = action
  return action
}

test('broker reports mechanical session application or submission without judging login state', async () => {
  const kms = fixtureKms()
  const password = await seal(kms, owner, Buffer.from(JSON.stringify({ username: 'fixture-user', password: 'fixture-password' })))
  const snapshot = await sealSession(kms, owner, password.wrappedDek, Buffer.from(JSON.stringify({ cookies: [], localStorage: [] })))
  for (const forcePassword of [false, true]) {
    const calls: string[] = []
    let guardEnded = false
    const claimed = { user_id: owner.userId, workspace_id: 'workspace', bot_id: 'bot', run_id: null, subagent_id: 'subagent', credential_id: owner.credentialId, origin: owner.origin, input_kind: 'password', target: { targetId: 'target', origin: owner.origin, endpoint: 'https://example.e2b.app/', expiresAt: Date.now() + 60000, credentialMode: forcePassword ? 'password' : 'session-first', observedInput: { loaderId: 'loader', backendNodeId: 7, credentialRole: 'password', epoch: 1, permissionVersion: 0 } } }
    bindFixtureAction(claimed)
    const credential = { wrapped_dek: password.wrappedDek, nonce: password.nonce, ciphertext: password.ciphertext, username: 'fixture-user' }
    const session = { wrapped_dek: snapshot.wrappedDek, nonce: snapshot.nonce, ciphertext: snapshot.ciphertext }
    const client = {
      async query(sql: string) {
        if (sql.includes('FROM bots ') || sql.includes('FROM agent_runs ')) return { rows: [{ id: 'ok' }] }
        if (sql.includes('FROM bot_subagents s JOIN')) return { rows: [{ targetId: 'target', epoch: 1, permissionVersion: 0, permission: 'ask', sandboxId: 'synthetic-sandbox', runPolicy: defaultRunPolicy() }] }
        if (sql.includes('FROM bot_subagents ')) return { rows: [{ id: 'ok' }] }
        if (sql.includes('JOIN credential_secrets')) return { rows: [credential] }
        if (sql.includes('FROM pending_actions')) return { rows: [{ id: 'synthetic' }], rowCount: 1 }
        if (sql.includes('FROM browser_sessions')) return { rows: [session] }
        return { rows: [] }
      }, release() {},
    }
    const pool = { async query() { return { rows: [claimed], rowCount: 1 } }, async connect() { return client } }
    const cdp = {
      async attach() {}, async origin() {}, async safeToResume() { return true }, close() {},
      async insertAtObservedInput(origin: string, loader: string, node: number, role: string, value: string) {
        assert.deepEqual([origin, loader, node, role], [owner.origin, 'loader', 7, 'password'])
        assert.equal(value, 'fixture-password')
        calls.push('insertAtObservedInput')
      },
      async call(method: string) {
        calls.push(method)
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { url: owner.origin, loaderId: 'loader' } } }
        if (method === 'Runtime.evaluate') return { result: { objectId: 'fixture' } }
        if (method === 'Network.getCookies') return { cookies: [] }
        return {}
      },
      async evaluate(expression: string) { calls.push(`evaluate:${expression}`); return [] },
    }
    const result = await fillCredential(pool as never, 'a'.repeat(43), { kms, guard: { begin: async () => ({ cdpUrl: 'wss://example.e2b.app/', targetId: 'target', guardToken: 'fixture' }), end: async () => { guardEnded = true } }, connect: (async () => cdp) as never })
    assert.equal(result.status, forcePassword ? 'guarded' : 'session_applied')
    assert.equal(calls.includes('insertAtObservedInput'), forcePassword)
    assert.equal(calls.includes('Page.reload'), !forcePassword)
    assert.equal(guardEnded, !forcePassword)
    assert(!calls.some(call => /readyState|one-time-code|input\[type/.test(call)))
  }
})

test('password retry is bound to the server-authorized caller and its one-use target', async () => {
  const caller = { userId: 'owner-a', workspaceId: 'workspace-a', botId: 'bot-a', runId: 'run-a' }
  const captured: { values?: unknown[] } = {}
  const pool = { async query(sql: string, values: unknown[]) {
    if (sql.includes('FROM bots ')) return { rows: values[1] === caller.userId && values[2] === caller.workspaceId ? [{ id: caller.botId }] : [] }
    if (sql.includes('FROM agent_runs ')) return { rows: values[1] === caller.userId && values[2] === caller.botId ? [{ id: caller.runId }] : [] }
    if (sql.includes('FROM credentials ')) return { rows: [{ id: 'credential-fixture' }] }
    if (sql.includes('INSERT INTO credential_fill_leases')) { captured.values = values; return { rows: [] } }
    throw new Error('unexpected query')
  } }
  const store = new CredentialStore(pool as never, fixtureKms())
  const target = { targetId: 'target', origin: owner.origin, endpoint: 'https://example.e2b.app/', expiresAt: Date.now() + 60000 }
  const result = await store.lease(caller, owner.origin, target, undefined, true)
  assert.equal(result.status, 'ready')
  assert.ok(captured.values)
  assert.equal((captured.values[8] as { credentialMode?: string }).credentialMode, 'password')
  assert.deepEqual(captured.values.slice(2, 7), [caller.userId, caller.workspaceId, caller.botId, null, caller.runId])
  captured.values = undefined
  await assert.rejects(store.lease({ ...caller, workspaceId: 'other' }, owner.origin, target, undefined, true), CredentialError)
  assert.equal(captured.values, undefined)
})

test('broker rejects a lease without a trusted observed target before opening credentials', async () => {
  const claimed = { user_id: 'owner', workspace_id: 'workspace', bot_id: 'bot', subagent_id: 'subagent', run_id: null, credential_id: 'credential', origin: 'https://example.com', target: { targetId: 'target', origin: 'https://example.com', endpoint: 'https://example.e2b.app/', expiresAt: Date.now() + 60000 } }
  let began = false
  const client = { async query(sql: string) { return { rows: sql.includes('SELECT id FROM') ? [{ id: 'ok' }] : [] } }, release() {} }
  const pool = { async query() { return { rows: [claimed], rowCount: 1 } }, async connect() { return client } }
  const kms: Kms = { async generate() { throw new Error('unexpected') }, async decrypt() { throw new Error('unexpected') } }
  await assert.rejects(fillCredential(pool as never, 'a'.repeat(43), { kms, guard: { begin: async () => { began = true; throw new Error('unexpected') }, end: async () => {} } }), CredentialError)
  assert.equal(began, false)
})

test('broker rejects changed epoch, policy, target, origin and loader before decryption', async () => {
  for (const failure of ['epoch', 'policy', 'deny', 'target', 'origin', 'loader'] as const) {
    const origin = 'https://example.com'
    const observedInput = { loaderId: 'loader', backendNodeId: 7, credentialRole: 'password', epoch: 1, permissionVersion: 1 }
    const target = { targetId: 'target', origin: failure === 'origin' ? 'https://other.example' : origin, endpoint: 'https://example.e2b.app/', expiresAt: Date.now() + 60000, observedInput }
    const claimed = { user_id: 'owner', workspace_id: 'workspace', bot_id: 'bot', subagent_id: 'subagent', run_id: null, credential_id: 'credential', origin, target }
    bindFixtureAction(claimed)
    const bound = { sandboxId: 'synthetic-sandbox', targetId: failure === 'target' ? 'other' : 'target', epoch: failure === 'epoch' ? 2 : 1, permissionVersion: failure === 'policy' ? 2 : 1, permission: failure === 'deny' ? 'deny' : 'ask', runPolicy: defaultRunPolicy() }
    const client = { async query(sql: string) {
      if (sql.includes('FROM bot_subagents s JOIN')) return { rows: [bound] }
      if (sql.includes('FROM pending_actions')) return { rows: [{ id: 'synthetic' }], rowCount: 1 }
      if (sql.includes('SELECT id FROM')) return { rows: [{ id: 'ok' }] }
      if (sql.includes('JOIN credential_secrets')) return { rows: [{ wrapped_dek: 'synthetic' }] }
      return { rows: [] }
    }, release() {} }
    const pool = { async query() { return { rows: [claimed], rowCount: 1 } }, async connect() { return client } }
    let decrypted = false
    const kms: Kms = { async generate() { throw new Error('unexpected') }, async decrypt() { decrypted = true; throw new Error('unexpected') } }
    const cdp = { async attach() {}, async origin() {}, async call() { return { frameTree: { frame: { url: origin, loaderId: 'stale' } } } }, close() {} }
    await assert.rejects(fillCredential(pool as never, 'a'.repeat(43), { kms, guard: { begin: async () => ({ cdpUrl: 'wss://example.e2b.app/', targetId: 'target', guardToken: 'fixture' }), end: async () => {} }, connect: (async () => cdp) as never }), CredentialError, failure)
    assert.equal(decrypted, false, failure)
  }
})

test('credential action fails closed when the trusted page binding changes', () => {
  const page: CredentialPageBinding = { userId: 'owner', workspaceId: 'workspace', botId: 'bot', subagentId: 'subagent', epoch: 7, targetId: 'target', origin: 'https://example.com', loaderId: 'loader', permissionAction: 'computer_use', permissionVersion: 1 }
  const lease = { ...page, expiresAt: 2000 }
  assert.doesNotThrow(() => assertCredentialPageBinding(lease, page, 1000))
  for (const changed of [
    { userId: 'other' }, { workspaceId: 'other' }, { botId: 'other' }, { subagentId: 'other' },
    { epoch: 8 }, { targetId: 'other' }, { origin: 'https://other.example' }, { loaderId: 'other' },
    { permissionAction: 'other' as never }, { permissionVersion: 2 },
  ]) assert.throws(() => assertCredentialPageBinding(lease, { ...page, ...changed }, 1000), CredentialError)
  assert.throws(() => assertCredentialPageBinding(lease, page, 2000), CredentialError)
  assert.throws(() => assertCredentialPageBinding({ ...lease, origin: 'https://user@example.com' }, page, 1000), CredentialError)
})

test('observed input focus uses a top-document CDP node with a matching type', async () => {
  const cdp = Object.create(Cdp.prototype) as Cdp
  const calls: string[] = []
  let root: unknown = { nodeName: '#document', children: [{ nodeName: 'INPUT', backendNodeId: 7, attributes: ['type', 'password'] }] }
  let focusedNode = 7
  cdp.call = async (method, params) => {
    calls.push(method)
    if (method === 'DOM.getDocument') return { root }
    if (method === 'Runtime.evaluate') return { result: { objectId: 'focused-fixture' } }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: focusedNode } }
    return { params }
  }
  await cdp.focusObservedInput(7, 'password')
  assert.deepEqual(calls, ['DOM.getDocument', 'DOM.focus', 'Runtime.evaluate', 'DOM.describeNode', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent'])
  focusedNode = 8
  await assert.rejects(cdp.focusObservedInput(7, 'password'), CredentialError)
  focusedNode = 7
  await assert.rejects(cdp.focusObservedInput(7, 'username'), CredentialError)
  await assert.rejects(cdp.focusObservedInput(7, 'code' as never), CredentialError)
  await assert.rejects(cdp.focusObservedInput(8, 'password'), CredentialError)
  root = { nodeName: '#document', children: [{ nodeName: 'INPUT', backendNodeId: 7, attributes: ['type', 'password', 'disabled', ''] }] }
  await assert.rejects(cdp.focusObservedInput(7, 'password'), CredentialError)
  root = { nodeName: '#document', children: [{ nodeName: 'IFRAME', contentDocument: { children: [{ nodeName: 'INPUT', backendNodeId: 7, attributes: ['type', 'password'] }] } }] }
  await assert.rejects(cdp.focusObservedInput(7, 'password'), CredentialError)
  root = { nodeName: '#document', children: [{ nodeName: 'DIV', shadowRoots: [{ children: [{ nodeName: 'INPUT', backendNodeId: 7, attributes: ['type', 'password'] }] }] }] }
  await assert.rejects(cdp.focusObservedInput(7, 'password'), CredentialError)
})

test('insertion uses only the observed node on the bound origin and document', async () => {
  const cdp = Object.create(Cdp.prototype) as Cdp
  let actualLoader = 'loader', actualOrigin = 'https://example.com', focused = 7
  const calls: string[] = []
  cdp.call = async method => {
    calls.push(method)
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { loaderId: actualLoader, url: actualOrigin } } }
    if (method === 'DOM.getDocument') return { root: { nodeName: '#document', children: [{ nodeName: 'INPUT', backendNodeId: 7, attributes: ['type', 'password'] }] } }
    if (method === 'Runtime.evaluate') return { result: { objectId: 'fixture' } }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: focused } }
    return {}
  }
  await cdp.insertAtObservedInput('https://example.com', 'loader', 7, 'password', 'synthetic')
  assert.equal(calls.filter(method => method === 'Input.insertText').length, 1)
  for (const [loader, origin, node] of [['other', 'https://example.com', 7], ['loader', 'https://other.example', 7], ['loader', 'https://example.com', 8]] as const) {
    actualLoader = loader; actualOrigin = origin; focused = node; calls.length = 0
    await assert.rejects(cdp.insertAtObservedInput('https://example.com', 'loader', 7, 'password', 'synthetic'), CredentialError)
    assert(!calls.includes('Input.insertText'))
  }
  await assert.rejects(cdp.fill('https://example.com', 'synthetic', 'synthetic'), CredentialError)
  await assert.rejects(cdp.fillOtp('https://example.com', '123456'), CredentialError)
})
