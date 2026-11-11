import assert from 'node:assert/strict'
import test from 'node:test'
import { audienceChange, readableAccounts, rechain, type AccessLink } from './audience'

// The readable-set rules of the confirmAccess handshake (ALE-26). Pure: no
// database, no auth. The database wiring is exercised in resource-access.db.test.ts.

const OWNER = 'owner'
const MEMBER = 'member'
const GRANTEE = 'grantee'
const MEMBERS = [OWNER, MEMBER]

const link = (over: Partial<AccessLink> = {}): AccessLink =>
  ({ kind: 'task', id: 'task', ownerId: OWNER, visibility: 'private', grants: [], ...over })

test('a private chain reads for its owner and its grantees, never for other members', () => {
  const privateChain = readableAccounts([link()], MEMBERS)
  assert.deepEqual([...privateChain].sort(), [OWNER])
  const granted = readableAccounts([link({ grants: [GRANTEE] })], MEMBERS)
  assert.deepEqual([...granted].sort(), [GRANTEE, OWNER].sort())
})

test('a shared chain reads for every member plus the accounts it names', () => {
  assert.deepEqual([...readableAccounts([link({ visibility: 'shared' })], MEMBERS)].sort(), [...MEMBERS].sort())
  assert.deepEqual([...readableAccounts([link({ visibility: 'shared', grants: [GRANTEE] })], MEMBERS)].sort(), [...MEMBERS, GRANTEE].sort())
})

test('a reader must satisfy every link, so a private ancestor narrows a shared child', () => {
  const chain = [link({ kind: 'task', visibility: 'shared' }), link({ kind: 'project', id: 'project', visibility: 'private' })]
  // The project admits only the owner; the shared task would have admitted the member.
  assert.deepEqual([...readableAccounts(chain, MEMBERS)].sort(), [OWNER])
  const grantedAncestor = [link({ kind: 'task', visibility: 'shared' }), link({ kind: 'project', id: 'project', grants: [MEMBER] })]
  assert.deepEqual([...readableAccounts(grantedAncestor, MEMBERS)].sort(), [MEMBER, OWNER].sort())
})

test('a quarantined link admits nobody, not even the owner', () => {
  assert.deepEqual([...readableAccounts([link({ visibility: 'quarantined' })], MEMBERS)], [])
  assert.deepEqual([...readableAccounts([link(), link({ kind: 'project', id: 'project', visibility: 'quarantined' })], MEMBERS)], [])
})

test('a different reader set is a change; an identical one is not', () => {
  const same = audienceChange([link({ visibility: 'shared' })], [link({ visibility: 'shared', id: 'task' })], MEMBERS)
  assert.deepEqual(same, { changed: false, narrowed: false, added: [], removed: [] })
  assert.equal(audienceChange([], [], MEMBERS).changed, false, 'no chain reads for nobody both ways')
})

test('attaching a task under a private parent narrows it and says who lost access', () => {
  const change = audienceChange([link({ visibility: 'shared' })], [link({ visibility: 'shared' }), link({ kind: 'project', id: 'project' })], MEMBERS)
  assert.equal(change.changed, true)
  assert.equal(change.narrowed, true, 'a shared task moving under a private project narrows its readers')
  assert.deepEqual(change.removed, [MEMBER])
  assert.deepEqual(change.added, [])
})

test('detaching a shared task from a private parent widens it back to the whole workspace', () => {
  const change = audienceChange([link({ visibility: 'shared' }), link({ kind: 'project', id: 'project' })], [link({ visibility: 'shared' })], MEMBERS)
  assert.equal(change.changed, true)
  assert.equal(change.narrowed, false, 'nothing is removed when access only widens')
  assert.deepEqual(change.added, [MEMBER])
  assert.deepEqual(change.removed, [])
})

test('a widening and a narrowing at once reports both accounts and counts as narrowing', () => {
  const change = audienceChange([link({ grants: [GRANTEE] })], [link({ grants: [MEMBER] })], MEMBERS)
  assert.equal(change.changed, true)
  assert.equal(change.narrowed, true, 'losing a reader outranks gaining one')
  assert.deepEqual(change.removed, [GRANTEE])
  assert.deepEqual(change.added, [MEMBER])
})

test('moving between two parents with the same audience is not a change', () => {
  const before = [link(), link({ kind: 'project', id: 'a', grants: [GRANTEE] })]
  const after = [link(), link({ kind: 'project', id: 'b', grants: [GRANTEE] })]
  assert.equal(audienceChange(before, after, MEMBERS).changed, false)
})

test('moving a task keeps its own policy and swaps only its ancestry', () => {
  const own = link({ visibility: 'shared', grants: [GRANTEE] })
  const project = link({ kind: 'project', id: 'project' })
  assert.deepEqual(rechain([own], [project]), [own, project])
  assert.deepEqual(rechain([own], null), [own], 'detaching leaves the task alone above itself')
  assert.deepEqual(rechain([], [project]), [], 'a task with no policy has no chain to move')
})

test('attaching a shared task under a private project is confirmed as narrowing', () => {
  const own = link({ visibility: 'shared' })
  const project = link({ kind: 'project', id: 'project' })
  const change = audienceChange([own], rechain([own], [project]), MEMBERS)
  assert.equal(change.changed, true)
  assert.equal(change.narrowed, true)
  assert.deepEqual(change.removed, [MEMBER])
})

test('attaching a private task under a shared project changes nobody', () => {
  const own = link()
  const shared = link({ kind: 'project', id: 'project', visibility: 'shared' })
  assert.equal(audienceChange([own], rechain([own], [shared]), MEMBERS).changed, false,
    'a private task stays its owner\'s: the shared parent adds no reader it lacked')
})
