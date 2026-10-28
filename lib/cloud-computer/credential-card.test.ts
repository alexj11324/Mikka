import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, beforeEach, mock, test } from 'node:test'
const origin = 'https://example.test', preview = 'https://preview.test'
const botId = randomUUID(), subagentId = randomUUID(), workspaceId = randomUUID()
const actor = { userId: 'fixture-owner', workspaceId }
let saves = 0, resumes = 0, legacyLogins = 0, otpLeases = 0
let payload: { password?: string } | undefined
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
mock.module(new URL('../credentials/runtime.ts', import.meta.url).href, { namedExports: {
  credentialActor: async () => actor,
  credentialStore: { authorize: async () => {}, save: async (_actor: unknown, input: { password: string }) => { saves++; payload = input }, otpLease: async () => { otpLeases++; throw Error('unexpected OTP') } },
  resolveCredentialBrowser: async () => ({ origin }),
  login: async () => { legacyLogins++; throw Error('Legacy fill must not run') },
  executeCredentialLease: async () => { throw Error('Unbound lease must not run') },
} })
mock.module(new URL('./subagents.ts', import.meta.url).href, { namedExports: { SubagentStore: class {
  async resumeAfterCredential(caller: typeof actor, bot: string, id: string, site: string) {
    assert.equal(caller.userId, actor.userId); assert.equal(caller.workspaceId, workspaceId)
    assert.equal(bot, botId); assert.equal(id, subagentId); assert.equal(site, origin)
    if (payload) assert.equal(payload.password, '', 'parsed password cleared before workflow resume')
    resumes++
  }
} } })
let route: typeof import('../credentials/route').subagentCredentialRoute
before(async () => { route = (await import('../credentials/route')).subagentCredentialRoute })
beforeEach(() => { saves = 0; resumes = 0; legacyLogins = 0; otpLeases = 0; payload = undefined })
function request(body: unknown, requestOrigin = preview) {
  return new Request(`${preview}/credentials`, { method: 'POST', headers: { origin: requestOrigin, 'x-mikka-credential': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
test('a saved login resumes the original workflow without an unbound fill or login-success claim', async () => {
  const response = await route(request({ nonce: 'a'.repeat(43), origin, username: 'fixture-user', password: 'synthetic-fixture-password' }), botId, subagentId, 'submit')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'saved', origin })
  assert.equal(saves, 1); assert.equal(resumes, 1); assert.equal(legacyLogins, 0)
})
test('reuse request wakes the same model workflow without choosing inputs in code', async () => {
  const response = await route(request({ site: origin }), botId, subagentId, 'login')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'resumed', origin })
  assert.equal(saves, 0); assert.equal(resumes, 1); assert.equal(legacyLogins, 0)
})
test('cross-site and wrong-origin submissions never save or resume', async () => {
  const body = { nonce: 'a'.repeat(43), origin, username: 'fixture-user', password: 'synthetic-fixture-password' }
  assert.equal((await route(request(body, 'https://other.test'), botId, subagentId, 'submit')).status, 403)
  assert.equal((await route(request({ ...body, origin: 'https://other.test' }), botId, subagentId, 'submit')).status, 404)
  assert.equal(saves, 0); assert.equal(resumes, 0)
})
test('verification codes require handover instead of entering a second automatic login path', async () => {
  const response = await route(request({ nonce: 'a'.repeat(43), origin, code: '123456' }), botId, subagentId, 'submit')
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'credential_handover_required' })
  assert.equal(otpLeases, 0); assert.equal(resumes, 0); assert.equal(legacyLogins, 0)
})
