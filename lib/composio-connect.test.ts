import assert from 'node:assert/strict'
import test from 'node:test'
import { ComposioEmailLookupError, providerAnswer, takeoverAccount, toConnectedAccountView, withAccountRecords, type ComposioAccountRecord } from './composio-accounts'
import { backfillComposioEmails, followUpComposioConnect, reconnectHandover, type ComposioListedAccount } from './composio-connect'

const gmail = (id: string, createdAt: string, extra: Partial<ComposioListedAccount> = {}): ComposioListedAccount =>
  ({ id, status: 'ACTIVE', isDisabled: false, alias: null, createdAt, toolkit: { slug: 'gmail' }, ...extra })
const record = (accountId: string, extra: Partial<ComposioAccountRecord> = {}): ComposioAccountRecord =>
  ({ accountId, email: null, emailChecked: false, lastAttemptAt: null, isDefault: false, ...extra })

function fakeDeps(emails: Record<string, string | null | Error> = {}) {
  const calls: string[] = []
  return {
    calls,
    deps: {
      readEmail: async (_toolkit: string, id: string) => {
        calls.push(`read ${id}`)
        const answer = emails[id]
        if (answer instanceof Error) throw answer
        return answer ?? null
      },
      saveEmail: async (_toolkit: string, id: string, email: string | null) => { calls.push(`save ${id} ${email}`) },
      rename: async (id: string, alias: string) => { calls.push(`rename ${id} ${alias}`) },
      noteAttempt: async (_toolkit: string, id: string) => { calls.push(`attempt ${id}`) },
      retire: async (id: string) => { calls.push(`retire ${id}`) },
      chooseDefault: async (_toolkit: string, id: string) => { calls.push(`default ${id}`) },
      log: (step: string) => { calls.push(`log ${step}`) },
    },
  }
}

test('reconnecting the expired account the person chose as default keeps it the default', async () => {
  // The old account really is EXPIRED, so it is not the effective default
  // (that would be `other`); the person's choice is what carries over.
  const old = gmail('old', '2026-09-01T00:00:00Z', { alias: '工作邮箱', status: 'EXPIRED' })
  const other = gmail('other', '2026-08-01T00:00:00Z')
  const added = gmail('new', '2026-10-28T00:00:00Z')
  const items = [other, old, added]
  const records = [record('old', { email: 'work@example.com', isDefault: true })]
  assert.deepEqual(reconnectHandover(items, records, 'old'), { alias: '工作邮箱', isDefault: true })
  const { calls, deps } = fakeDeps({ new: 'work@example.com' })
  await followUpComposioConnect({ items, records, addedId: 'new', replaceId: 'old' }, deps)
  // Retire first (frees the old name), then the name and default move, then the email is kept without renaming over the custom name.
  assert.deepEqual(calls, ['retire old', 'rename new 工作邮箱', 'default new', 'read new', 'save new work@example.com'])
})

test('an expired account that was never chosen does not take the default from a working one', () => {
  const items = [gmail('other', '2026-08-01T00:00:00Z'), gmail('old', '2026-07-01T00:00:00Z', { status: 'EXPIRED' }), gmail('new', '2026-10-28T00:00:00Z')]
  assert.equal(reconnectHandover(items, [], 'old').isDefault, false)
})

test('a reconnect does not carry an alias that was only the old email, nor a default it did not have', async () => {
  const items = [gmail('first', '2026-08-01T00:00:00Z'), gmail('old', '2026-09-01T00:00:00Z', { alias: 'Work@Example.com' }), gmail('new', '2026-10-28T00:00:00Z')]
  const records = [record('old', { email: 'work@example.com' })]
  assert.deepEqual(reconnectHandover(items, records, 'old'), { alias: null, isDefault: false })
  const { calls, deps } = fakeDeps({ new: 'work@example.com' })
  await followUpComposioConnect({ items, records, addedId: 'new', replaceId: 'old' }, deps)
  assert.deepEqual(calls, ['retire old', 'read new', 'save new work@example.com', 'rename new work@example.com'])
})

test('the only account being reconnected stays the default', () => {
  const items = [gmail('old', '2026-09-01T00:00:00Z'), gmail('new', '2026-10-28T00:00:00Z')]
  assert.equal(reconnectHandover(items, [], 'old', 'new').isDefault, true)
})

test('a failed retire still reads the email; another toolkit is never retired', async () => {
  const items = [gmail('old', '2026-09-01T00:00:00Z'), gmail('new', '2026-10-28T00:00:00Z'), { ...gmail('n1', '2026-01-01T00:00:00Z'), toolkit: { slug: 'notion' } }]
  const { calls, deps } = fakeDeps({ new: 'me@example.com' })
  const completed = await followUpComposioConnect({ items, records: [], addedId: 'new', replaceId: 'old' }, { ...deps, retire: async () => { throw new Error('boom') } })
  assert.equal(completed, false)
  assert.deepEqual(calls, ['log retire', 'read new', 'save new me@example.com', 'rename new me@example.com'])
  const second = fakeDeps()
  await followUpComposioConnect({ items, records: [], addedId: 'new', replaceId: 'n1' }, second.deps)
  assert.deepEqual(second.calls, ['read new', 'save new null'])
})

test('a non-working replacement never retires the old connection or takes its default', async () => {
  for (const extra of [{ status: 'INITIATED' }, { status: 'FAILED' }, { isDisabled: true }]) {
    const items = [gmail('old', '2026-09-01T00:00:00Z'), gmail('new', '2026-10-28T00:00:00Z', extra)]
    const { calls, deps } = fakeDeps()
    const completed = await followUpComposioConnect({ items, records: [record('old', { isDefault: true })], addedId: 'new', replaceId: 'old' }, deps)
    assert.equal(completed, false)
    assert.ok(!calls.some(call => call.startsWith('retire ') || call.startsWith('default ')))
  }
})

test('old accounts get their email on load: at most five, in parallel, each asked once', async () => {
  const items = Array.from({ length: 7 }, (_, index) => gmail(`a${index}`, `2026-0${index + 1}-01T00:00:00Z`))
  items.push(gmail('off', '2026-01-01T00:00:00Z', { isDisabled: true }), gmail('expired', '2026-01-01T00:00:00Z', { status: 'EXPIRED' }))
  const records = [record('a0', { email: 'known@example.com', emailChecked: true }), record('a1', { emailChecked: true, isDefault: true })]
  let inFlight = 0
  let maxInFlight = 0
  const { calls, deps } = fakeDeps({ a2: 'two@example.com', a3: null, a4: new Error('timeout') })
  const read = deps.readEmail
  deps.readEmail = async (toolkit, id) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(resolve => setTimeout(resolve, 5))
    inFlight -= 1
    return read(toolkit, id)
  }
  const now = new Date('2026-10-28T12:00:00Z')
  const filled = await backfillComposioEmails({ items, records, now }, deps)
  assert.deepEqual(calls.filter(call => call.startsWith('read')).sort(), ['read a2', 'read a3', 'read a4', 'read a5', 'read a6'])
  assert.equal(maxInFlight, 5)
  // Found and not-found are both kept; a lookup that failed is not, so the next load asks again.
  assert.ok(calls.includes('save a2 two@example.com') && calls.includes('save a3 null') && !calls.some(call => call.startsWith('save a4')))
  assert.ok(calls.includes('attempt a4'))
  assert.ok(calls.includes('rename a2 two@example.com'))
  const byId = new Map(filled.map(item => [item.accountId, item]))
  assert.deepEqual(byId.get('a2'), { accountId: 'a2', email: 'two@example.com', emailChecked: true, lastAttemptAt: now, isDefault: false })
  assert.equal(byId.get('a3')?.emailChecked, true)
  assert.deepEqual(byId.get('a4'), { accountId: 'a4', email: null, emailChecked: false, lastAttemptAt: now, isDefault: false })
  assert.equal(byId.get('a1')?.isDefault, true)

  // The failed one waits about an hour, so loads in between do not wait on it.
  const soon = fakeDeps()
  await backfillComposioEmails({ items, records: filled, now: new Date(now.getTime() + 10 * 60_000) }, soon.deps)
  assert.deepEqual(soon.calls, [])
  const later = fakeDeps()
  await backfillComposioEmails({ items, records: filled, now: new Date(now.getTime() + 61 * 60_000) }, later.deps)
  assert.deepEqual(later.calls.filter(call => call.startsWith('read')), ['read a4'])
})

test('turning off or disconnecting the default names the account that takes over', () => {
  const view = (id: string, createdAt: string, extra: Partial<ComposioListedAccount> = {}) => toConnectedAccountView(gmail(id, createdAt, extra))!
  const accounts = withAccountRecords([view('a', '2026-08-01T00:00:00Z'), view('b', '2026-09-01T00:00:00Z'), view('c', '2026-10-01T00:00:00Z', { isDisabled: true })], [record('b', { isDefault: true })])
  assert.deepEqual(takeoverAccount(accounts, 'a'), { affectsBots: false })
  const next = takeoverAccount(accounts, 'b')
  assert.equal(next.affectsBots && next.next?.id, 'a')
  const alone = withAccountRecords([view('a', '2026-08-01T00:00:00Z')], [])
  assert.deepEqual(takeoverAccount(alone, 'a'), { affectsBots: true, next: null })
})

test('only a 2xx without an email or a 403 is a final "no email"; 429, 5xx and 401 are tried again', () => {
  assert.deepEqual(providerAnswer(200, { emailAddress: 'a@example.com' }), { emailAddress: 'a@example.com' })
  assert.equal(providerAnswer(403, { error: 'insufficientPermissions' }), null)
  for (const status of [401, 404, 429, 500, 503]) assert.throws(() => providerAnswer(status, {}), ComposioEmailLookupError)
})


test('reconnect reports completion only after the expected old account is retired', async () => {
  const items = [gmail('old', '2026-09-01T00:00:00Z'), gmail('new', '2026-10-28T00:00:00Z')]
  const { deps } = fakeDeps()
  assert.equal(await followUpComposioConnect({ items, records: [], addedId: 'new', replaceId: 'old' }, deps), true)
  assert.equal(await followUpComposioConnect({ items, records: [], addedId: 'new', replaceId: 'missing' }, deps), false)
  assert.equal(await followUpComposioConnect({ items, records: [], addedId: 'missing', replaceId: 'old' }, deps), false)
})


test('failed alias or default handover is not reported as a complete reconnect', async () => {
  const items = [gmail('old', '2026-09-01T00:00:00Z', { alias: 'work' }), gmail('new', '2026-10-28T00:00:00Z')]
  const records = [record('old', { isDefault: true })]
  for (const step of ['rename', 'chooseDefault'] as const) {
    const { deps } = fakeDeps()
    const failing = { ...deps, [step]: async () => { throw new Error('failed') } }
    assert.equal(await followUpComposioConnect({ items, records, addedId: 'new', replaceId: 'old' }, failing), false)
  }
})
