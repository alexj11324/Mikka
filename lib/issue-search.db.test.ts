// Dev-local DB tests for the relation picker search. Run through ~/.mikka/local-run.sh.
// Without a database they skip, unless REQUIRE_DB=1, which makes a missing DB a failure.
// Every test runs in a transaction that is rolled back, so dev-local keeps no rows.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { issueSearchVisibility } from '@/lib/issue-search-visibility'
import { parseSearchParams, RELATION_DEPTH_LIMIT, searchIssues, type CurrentIssue } from '@/lib/issue-search'

const url = process.env.MIKKA_DATABASE_URL
const host = url ? new URL(url) : null
// The bridge port defaults to dev-local's 15432; MIKKA_TEST_DB_PORT overrides it (e.g. a CI service).
const port = process.env.MIKKA_TEST_DB_PORT || '15432'
const devLocal = !!host && host.hostname === '127.0.0.1' && host.port === port
if (process.env.REQUIRE_DB === '1' && !devLocal) throw new Error(`REQUIRE_DB=1 but MIKKA_DATABASE_URL is not dev-local (127.0.0.1:${port}); run via ~/.mikka/local-run.sh`)
const skip = devLocal ? false : 'no dev-local database (set REQUIRE_DB=1 to require it)'
const pool = devLocal ? new Pool({ connectionString: url, max: 2 }) : null
const db = pool ? drizzle(pool) : null
test.after(async () => { await pool?.end() })

class Rollback extends Error {}
async function inTx(fn: (tx: Parameters<Parameters<NonNullable<typeof db>['transaction']>[0]>[0]) => Promise<void>) {
  try { await db!.transaction(async tx => { await fn(tx); throw new Rollback() }) } catch (error) { if (!(error instanceof Rollback)) throw error }
}

type Tx = Parameters<Parameters<typeof inTx>[0]>[0]
const run = Date.now().toString(36)
async function user(tx: Tx, name: string) {
  const id = `mik16-${run}-${randomUUID()}`
  await tx.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${id}, ${name}, ${id + '@example.test'}, false, now(), now())`)
  return id
}
let clock = 0
async function issue(tx: Tx, ownerId: string, title: string, metadata: Record<string, unknown> = {}) {
  const id = randomUUID()
  const content = { type: 'doc', content: [], attrs: { mikka: metadata } }
  await tx.execute(sql`insert into issues (id, "userId", title, content, status, priority, "updatedAt") values (${id}, ${ownerId}, ${title}, ${JSON.stringify(content)}::jsonb, 'todo', 'normal', now() + make_interval(secs => ${++clock}::int))`)
  return id
}
async function member(tx: Tx, issueId: string, ownerId: string, memberId: string) {
  await tx.execute(sql`insert into issue_members ("issueId", "userId", "memberId") values (${issueId}, ${ownerId}, ${memberId})`)
}
const everyone = async (ids: string[]) => new Set(ids)
const search = (tx: Tx, userId: string, query: string, current: CurrentIssue | null = null, isVisible = everyone, publicIds: string[] = []) =>
  searchIssues(tx, { userId, params: parseSearchParams(new URLSearchParams(query)), publicIds, current, isVisible })
const tag = () => `mik16${Math.random().toString(36).slice(2, 8)}`

test('title, number and recent search honour visibility', { skip }, () => inTx(async tx => {
  const owner = await user(tx, 'Owner'), other = await user(tx, 'Stranger')
  const t = tag()
  const mine = await issue(tx, owner, `${t} 修复登录`, { number: 900001 })
  const hidden = await issue(tx, other, `${t} 别人的`, { number: 900001 })
  await issue(tx, owner, `${t} deleted`, { number: 900002, deletedAt: '2026-10-23T00:00:00.000Z' })
  const byTitle = await search(tx, owner, `q=${t}`)
  assert.deepEqual(byTitle.items.map(item => item.id), [mine])
  assert.equal(byTitle.items[0].identifier, 'ORV-900001')
  assert.equal(byTitle.items[0].ownerName, 'Owner')
  for (const q of ['ORV-900001', 'MIK-900001', '900001']) assert.deepEqual((await search(tx, owner, `q=${q}`)).items.map(item => item.id), [mine])
  assert.deepEqual((await search(tx, owner, 'q=900002')).items, [], 'deleted issue is not found')
  assert.deepEqual((await search(tx, owner, 'q=ORV-999999999')).items, [], 'missing number is empty, no title fallback')
  // Publicly linked (team) issues become visible through publicIds, and isVisible can drop them.
  const shared = await search(tx, owner, `q=${t}`, null, everyone, [hidden])
  assert.deepEqual(new Set(shared.items.map(item => item.id)), new Set([mine, hidden]))
  const filtered = await search(tx, owner, `q=${t}`, null, async ids => new Set(ids.filter(id => id !== hidden)), [hidden])
  assert.deepEqual(filtered.items.map(item => item.id), [mine])
  const recent = await search(tx, owner, 'limit=50')
  assert.equal(recent.items[0].id, mine, 'empty q returns the most recently updated first')
}))

test('duplicate numbers across owners are told apart by ownerName', { skip }, () => inTx(async tx => {
  const me = await user(tx, 'Me'), alice = await user(tx, 'Alice')
  const a = await issue(tx, me, 'mine', { number: 900010 })
  const b = await issue(tx, alice, 'shared', { number: 900010 })
  await member(tx, b, alice, me)
  const result = await search(tx, me, 'q=ORV-900010')
  assert.deepEqual(new Set(result.items.map(item => `${item.identifier}:${item.ownerName}`)), new Set(['ORV-900010:Me', 'ORV-900010:Alice']))
  assert.ok(result.items.some(item => item.id === a))
}))

test('single CJK character searches titles', { skip }, () => inTx(async tx => {
  const owner = await user(tx, 'Owner')
  const id = await issue(tx, owner, `${tag()} 版本发布`)
  const result = await search(tx, owner, 'q=版&limit=50')
  assert.ok(result.items.some(item => item.id === id))
}))

test('excludeDescendants / excludeAncestors use the capped CTE and report truncated', { skip }, () => inTx(async tx => {
  const owner = await user(tx, 'Owner')
  const t = tag()
  const chain: string[] = []
  for (let depth = 0; depth <= RELATION_DEPTH_LIMIT + 2; depth++) chain.push(await issue(tx, owner, `${t} level ${depth}`, { parentId: chain[depth - 1] ?? null }))
  const ids = async (query: string) => { const result = await search(tx, owner, `q=${t}&limit=50&${query}`); return { ids: new Set(result.items.map(item => item.id)), truncated: result.truncated } }
  // excludeId alone hides just that issue.
  const plain = await ids(`excludeId=${chain[2]}`)
  assert.equal(plain.ids.size, chain.length - 1)
  assert.ok(!plain.ids.has(chain[2]))
  // chain[2]: 2 ancestors, exactly 20 levels of descendants -> everything hidden, not truncated.
  const exact = await ids(`excludeId=${chain[2]}&excludeDescendants=1&excludeAncestors=1`)
  assert.equal(exact.ids.size, 0)
  assert.equal(exact.truncated, false)
  // chain[1]: 21 levels below -> the 21st stays visible and truncated is true.
  const deep = await ids(`excludeId=${chain[1]}&excludeDescendants=true`)
  assert.deepEqual([...deep.ids].sort(), [chain[0], chain[chain.length - 1]].sort())
  assert.equal(deep.truncated, true)
  // chain[22]: 22 levels above -> the two topmost stay visible, truncated is true.
  const up = await ids(`excludeId=${chain[chain.length - 1]}&excludeAncestors=true`)
  assert.deepEqual([...up.ids].sort(), [chain[0], chain[1]].sort())
  assert.equal(up.truncated, true)
}))

test('existingRelation and canRelate follow updateIssueRelation rules', { skip }, () => inTx(async tx => {
  const owner = await user(tx, 'Owner'), helper = await user(tx, 'Helper'), outsider = await user(tx, 'Outsider')
  const t = tag()
  const parent = await issue(tx, owner, `${t} parent`)
  const blocker = await issue(tx, owner, `${t} blocker`)
  const current = await issue(tx, owner, `${t} current`, { parentId: parent, blockedByIds: [blocker] })
  const child = await issue(tx, owner, `${t} child`, { parentId: current })
  const loose = await issue(tx, owner, `${t} loose`)
  const foreign = await issue(tx, outsider, `${t} foreign`)
  for (const id of [current, child, parent]) await member(tx, id, owner, helper)
  await member(tx, foreign, outsider, helper)
  const currentIssue = { id: current, ownerId: owner, metadata: { parentId: parent, blockedByIds: [blocker] } }
  const asOwner = await search(tx, owner, `q=${t}&limit=50&issueId=${current}`, currentIssue)
  const byId = new Map(asOwner.items.map(item => [item.id, item]))
  assert.equal(byId.get(parent)!.existingRelation, 'parent')
  assert.equal(byId.get(blocker)!.existingRelation, 'blockedBy')
  assert.equal(byId.get(child)!.existingRelation, 'child')
  assert.equal(byId.get(loose)!.existingRelation, null)
  assert.equal(byId.get(current)!.canRelate, false, 'cannot relate to itself')
  assert.ok([parent, blocker, child, loose].every(id => byId.get(id)!.canRelate), 'owner can relate any of their issues')
  const asHelper = new Map((await search(tx, helper, `q=${t}&limit=50&issueId=${current}`, currentIssue)).items.map(item => [item.id, item]))
  assert.equal(asHelper.get(child)!.canRelate, true, 'member of both')
  assert.equal(asHelper.get(foreign)!.canRelate, false, 'different owner')
  assert.equal(asHelper.has(blocker), false, 'not visible to the helper at all')
}))

test('paging with nextCursor walks every row once', { skip }, () => inTx(async tx => {
  const owner = await user(tx, 'Owner')
  const t = tag()
  const created = new Set<string>()
  for (let index = 0; index < 7; index++) created.add(await issue(tx, owner, `${t} row ${index}`))
  const seen: string[] = []
  let cursor: string | null = null
  do {
    const page = await search(tx, owner, `q=${t}&limit=3${cursor ? `&cursor=${cursor}` : ''}`, null, async ids => new Set(ids.filter((_, index) => index % 4 !== 3 || true)))
    seen.push(...page.items.map(item => item.id))
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(seen.length, 7)
  assert.deepEqual(new Set(seen), created)
}))

test('a 2500-id publicIds list still runs as one = ANY parameter', { skip }, () => inTx(async tx => {
  const owner = await user(tx, 'Owner'), viewer = await user(tx, 'Viewer')
  const t = tag()
  const target = await issue(tx, owner, `${t} public`)
  const publicIds = [...Array.from({ length: 2499 }, () => randomUUID()), target]
  const result = await search(tx, viewer, `q=${t}`, null, everyone, publicIds)
  assert.deepEqual(result.items.map(item => item.id), [target])
}))

test('paging keeps rows whose updatedAt differs only below the millisecond, and exact ties', { skip }, () => inTx(async tx => {
  const owner = await user(tx, 'Owner')
  const t = tag()
  const ids: string[] = []
  // Same millisecond: +300µs, +200µs, and two rows tied at exactly +100µs (ordered by id).
  for (const micros of [300, 200, 100, 100]) {
    const id = randomUUID()
    await tx.execute(sql`insert into issues (id, "userId", title, content, status, priority, "updatedAt") values (${id}, ${owner}, ${`${t} tie`}, '{"type":"doc","content":[],"attrs":{"mikka":{}}}'::jsonb, 'todo', 'normal', '2030-01-01T00:00:00.000Z'::timestamptz + make_interval(secs => ${micros / 1e6}::float8))`)
    ids.push(id)
  }
  const expected = [ids[0], ids[1], ...[ids[2], ids[3]].sort().reverse()]
  const seen: string[] = []
  let cursor: string | null = null
  do {
    const page = await search(tx, owner, `q=${t}&limit=1${cursor ? `&cursor=${cursor}` : ''}`)
    seen.push(...page.items.map(item => item.id))
    cursor = page.nextCursor
  } while (cursor && seen.length < 10)
  assert.deepEqual(seen, expected)
}))

test('team visibility across workspaces and teams, through the real query (no isVisible stub)', { skip }, () => inTx(async tx => {
  const me = await user(tx, 'Me'), alice = await user(tx, 'Alice')
  const t = tag()
  const wsA = randomUUID(), wsB = randomUUID(), wsC = randomUUID()
  const teamA = randomUUID(), teamA2 = randomUUID(), teamB = randomUUID(), teamC = randomUUID()
  for (const ws of [wsA, wsB, wsC]) await tx.execute(sql`insert into mikka_workspaces (id, "userId", name) values (${ws}, ${alice}, ${'ws ' + t})`)
  // I am active in A, active in B, suspended in C.
  for (const [ws, status] of [[wsA, 'active'], [wsB, 'active'], [wsC, 'suspended']] as const)
    await tx.execute(sql`insert into mikka_workspace_members ("workspaceId", "userId", name, email, role, status) values (${ws}, ${me}, 'Me', ${me + '@example.test'}, 'member', ${status})`)
  for (const [team, ws, ident] of [[teamA, wsA, 'TA'], [teamA2, wsA, 'TA2'], [teamB, wsB, 'TB'], [teamC, wsC, 'TC']])
    await tx.execute(sql`insert into orvilo_teams (id, "workspaceId", "userId", name, identifier) values (${team}, ${ws}, ${alice}, ${ident}, ${ident})`)
  const linked = async (title: string, team: string, ws: string) => {
    const id = await issue(tx, alice, `${t} ${title}`)
    await tx.execute(sql`insert into orvilo_team_issues ("issueId", "teamId", "workspaceId", "userId") values (${id}, ${team}, ${ws}, ${alice})`)
    return id
  }
  const inA = await linked('team A', teamA, wsA)
  const inA2 = await linked('team A2', teamA2, wsA)
  const inB = await linked('team B', teamB, wsB)
  const inC = await linked('team C (suspended)', teamC, wsC)
  const personal = await issue(tx, me, `${t} personal`)
  await issue(tx, alice, `${t} alice private`)

  const searchIn = async (ws: string) => {
    const { publicIds, isVisible } = await issueSearchVisibility(tx, me, ws)
    return new Set((await search(tx, me, `q=${t}&limit=50`, null, isVisible, publicIds)).items.map(item => item.id))
  }
  // Workspace A: both of A's teams plus my unlinked personal issue; not B's, C's or Alice's private one.
  assert.deepEqual(await searchIn(wsA), new Set([inA, inA2, personal]))
  // Workspace B: only B's team issue plus the personal one.
  assert.deepEqual(await searchIn(wsB), new Set([inB, personal]))
  // Suspended membership in C shows nothing from C, even when C is the current workspace.
  assert.deepEqual(await searchIn(wsC), new Set([personal]))
}))
