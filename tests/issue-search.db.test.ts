import { seedFixtureWorkspace } from './helpers/task-workspace'
import 'next/dist/server/node-environment-baseline'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { measured, readMetrics } from './helpers/read-metrics'

const url = process.env.E2E_DATABASE_URL
const authorized = disposableDatabase()
if (url && !authorized) throw new Error('Search DB tests require a loopback *_e2e database')
if (process.env.REQUIRE_DB === '1' && !authorized) throw new Error('Search DB tests cannot skip in required CI')

test('indexed workspace-isolated relation search beyond 101 tasks, paging and graph visibility', {skip: !authorized}, async () => {
  const {Pool} = await import('pg')
  const pool = new Pool({connectionString: url,max:2})
  const {db} = await import('../lib/db')
  const {parseSearchParams,searchIssues} = await import('../lib/issue-search')
  const {promoteExistingIssueForUser} = await import('../lib/team-issue-promotion')
  const {actAs} = await import('../lib/acting-user')
  const {tokenWorkspace} = await import('../lib/tokens/principal')
  const owner = `search-owner-${randomUUID()}`, viewer = `search-viewer-${randomUUID()}`
  const personalWorkspace = randomUUID(), workspace = randomUUID(), otherWorkspace = randomUUID(), team = randomUUID()
  const root = randomUUID(), child = randomUUID(), hidden = randomUUID(), shared = randomUUID(), otherShared = randomUUID()
  const params = (query: Record<string,string>) => parseSearchParams(new URLSearchParams(query))
  const search = (query: Record<string,string>, userId = owner, workspaceId = personalWorkspace) => searchIssues(db,{userId,workspaceId,params:params(query)})
  try {
    for (const file of ['20261026013000_issue_search_pg_trgm.sql','20261026013001_issue_search_title_idx.sql','20261026013002_issue_search_recent_idx.sql','20261026013003_issue_search_number_idx.sql']) {
      const text = await readFile(new URL(`../drizzle/${file}`,import.meta.url),'utf8')
      await pool.query(text)
      await pool.query(text) // idempotent migration replay, outside transactions
    }
    const indexes = await pool.query("select indexrelid::regclass::text name,indisvalid from pg_index where indexrelid::regclass::text like 'issues_%search%' or indexrelid::regclass::text='issues_owner_updated_id_idx'")
    assert.ok(indexes.rows.length>=3)
    assert.ok(indexes.rows.every(row=>row.indisvalid))
    for (const id of [owner,viewer]) await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())',[id,`${id}@example.invalid`])
    for (const [w,kind] of [[personalWorkspace,'personal'],[workspace,'team'],[otherWorkspace,'team']]) await pool.query('insert into mikka_workspaces (id,"userId",name,slug,kind) values ($1,$2,\'Search CI\',$3,$4)',[w,owner,`search-${w}`,kind])
    for (const [w,u] of [[personalWorkspace,owner],[workspace,owner],[workspace,viewer],[otherWorkspace,owner],[otherWorkspace,viewer]]) await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'member\',\'active\')',[w,u,`${u}@example.invalid`])
    await pool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Search CI\',\'SCI\')',[team,workspace,owner])
    // >100 recent rows cannot hide an older keyword match. Large synthetic
    // dataset also makes the real planner choice observable without prod data.
    await pool.query(`insert into issues (id,"userId","workspaceId","ownershipState",title,content,status,priority,scope,"updatedAt")
      select gen_random_uuid(),$1,$2,'bound','CI haystack '||g,jsonb_build_object('type','doc','attrs',jsonb_build_object('mikka',jsonb_build_object('number',g))),'todo','normal','personal',now() from generate_series(1,12000) g`,[owner,personalWorkspace])
    const add = async (id:string,title:string,scope='personal',meta:Record<string,unknown>={},workspaceId=personalWorkspace) => pool.query('insert into issues (id,"userId","workspaceId","ownershipState",title,content,status,priority,scope,"updatedAt") values ($1,$2,$3,\'bound\',$4,$5,\'todo\',\'normal\',$6,\'2020-01-01T00:00:00.123456Z\')',[id,owner,workspaceId,title,JSON.stringify({type:'doc',attrs:{mikka:{number:14000,...meta}},content:[]}),scope])
    await add(root,'rare-needle 修复 50%_off')
    await add(child,'child rare-needle','personal',{parentId:root,number:14001})
    await add(hidden,'private rare-needle','personal',{parentId:root,number:14002})
    await add(shared,'shared rare-needle','workspace',{number:14003},workspace)
    await add(otherShared,'other workspace rare-needle','workspace',{number:14004},otherWorkspace)
    // Historical invitation/team links cannot override the task's actual tenant.
    await pool.query('insert into issue_members ("issueId","userId","memberId") values ($1,$2,$3)',[hidden,owner,viewer])
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[hidden,team,workspace,owner])
    assert.deepEqual((await search({q:'rare-needle'})).items.map(x=>x.id).sort(),[root,child,hidden].sort())
    assert.ok((await search({q:'修'})).items.some(x=>x.id===root))
    assert.deepEqual((await search({q:'50%_off'})).items.map(x=>x.id),[root])
    assert.deepEqual((await search({q:'14000'})).items.map(x=>x.id),[root])
    assert.equal((await search({q:'rare-needle'},viewer)).items.length,0)
    await assert.rejects(search({issueId:hidden},viewer),/issueNotFound/)
    await assert.rejects(search({excludeId:hidden,excludeDescendants:'true'},viewer),/issueNotFound/)
    const seen = new Set<string>(); let cursor:string|null = null
    do {
      const result = await search({q:'rare-needle',limit:'1',...(cursor?{cursor}:{})})
      for (const row of result.items) {assert.ok(!seen.has(row.id));seen.add(row.id)}
      cursor=result.nextCursor
    } while(cursor)
    assert.equal(seen.size,3)
    const closure = await search({q:'rare-needle',issueId:root,excludeId:root,excludeDescendants:'true'})
    assert.equal(closure.items.length,0)
    // Team attachment cannot transfer a personal task into a shared tenant.
    const beforePromotion = (await pool.query('select * from issues where id=$1',[hidden])).rows[0]
    const revision = (await pool.query('select revision from issues where id=$1',[hidden])).rows[0].revision
    const requestId = randomUUID()
    assert.deepEqual(await promoteExistingIssueForUser(owner,{requestId,issueId:hidden,revision,teamId:team,expectedTeamId:team}),{error:'teamIssueAccessDenied',requestId})
    assert.deepEqual((await pool.query('select * from issues where id=$1',[hidden])).rows[0],beforePromotion)
    assert.equal((await pool.query('select count(*)::int n from team_issue_promotions where "requestId"=$1',[requestId])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from team_issue_promotion_receipts where "requestId"=$1',[requestId])).rows[0].n,0)
    // Shared tasks need no Team link. One account belongs to both workspaces;
    // only the effective workspace is searched, including graph anchors.
    assert.deepEqual((await search({q:'rare-needle'},viewer,workspace)).items.map(x=>x.id),[shared])
    assert.deepEqual((await search({q:'rare-needle'},viewer,otherWorkspace)).items.map(x=>x.id),[otherShared])
    assert.deepEqual((await search({q:'rare-needle',workspaceId:otherWorkspace},owner,workspace)).items.map(x=>x.id),[shared])
    await assert.rejects(search({issueId:otherShared},owner,workspace),/issueNotFound/)
    await assert.rejects(search({excludeId:otherShared,excludeDescendants:'true'},owner,workspace),/issueNotFound/)
    await actAs({id:owner,[tokenWorkspace]:workspace},async () => {
      assert.equal((await search({q:'rare-needle'},owner,otherWorkspace)).items.length,0)
      await assert.rejects(search({issueId:otherShared},owner,otherWorkspace),/issueNotFound/)
    })
    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2',[workspace,viewer])
    assert.equal((await search({q:'rare-needle'},viewer,workspace)).items.length,0)
    await assert.rejects(search({issueId:shared},viewer,workspace),/issueNotFound/)
    await assert.rejects(search({excludeId:shared,excludeDescendants:'true'},viewer,workspace),/issueNotFound/)
    assert.deepEqual((await search({q:'rare-needle'},viewer,otherWorkspace)).items.map(x=>x.id),[otherShared])
    assert.deepEqual((await search({q:'rare-needle'},owner,workspace)).items.map(x=>x.id),[shared])
    // Bulk fixture inserts leave GIN fast-update entries in its pending list.
    // Flush as normal vacuum would before measuring steady-state planner cost;
    // do not disable sequential scans or force an index plan.
    await pool.query("select gin_clean_pending_list('issues_title_search_trgm_idx'::regclass)")
    await pool.query('analyze issues')
    const plan=await pool.query('explain (analyze,buffers,format json) select id from issues where "userId"=$1 and title ilike $2 order by "updatedAt" desc,id desc limit 21',[owner,'%rare-needle%'])
    console.log('CI synthetic selective title EXPLAIN:',JSON.stringify(plan.rows[0]['QUERY PLAN']))
    assert.match(JSON.stringify(plan.rows[0]['QUERY PLAN']),/issues_title_search_trgm_idx/)
  } finally {
    // Retain synthetic fixtures on success and failure for audit and later inspection.
    // Closing the client pool does not delete database rows, schemas or the server.
    console.log('Issue-search fixture retention audit:', JSON.stringify({
      recordedAt: new Date().toISOString(), database: 'mikka_e2e', retention: 'preserve',
      note: 'Identifiers are allocated before setup; failed setup may leave only a subset present',
      owner, viewer, personalWorkspace, workspace, otherWorkspace, team, root, child, hidden, shared, otherShared,
    }))
    await pool.end()
  }
})

test('Telegram command reads preserve numbering and exact membership across team states', { skip: !authorized }, async t => {
  const { db, pool } = await import('../lib/db')
  const { parseSearchParams, searchIssues } = await import('../lib/issue-search')
  const { workspacePool } = await import('../lib/workspace-db')
  const { createTranslator } = await import('use-intl/core')
  const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8'))
  const translations = mock.module('next-intl/server', { namedExports: {
    getLocale: async () => 'en',
    getTranslations: async () => createTranslator({ locale: 'en', messages, namespace: 'TelegramBot' }),
  } })
  const owner = `telegram-wire-owner-${randomUUID()}`, other = `telegram-wire-other-${randomUUID()}`
  const workspace = randomUUID(), personalWorkspace = randomUUID(), team = randomUUID(), mine = randomUUID(), mineLinked = randomUUID(), otherLinked = randomUUID(), mineUnlinked = randomUUID()
  const telegramUserId = `telegram-wire-${randomUUID()}`, threadId = `telegram:${randomUUID()}`
  try {
    for (const [id, prefix] of [[owner, 'TLGX'], [other, 'OTHR']]) {
      await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [id, id + '@example.invalid'])
      await pool.query('insert into issue_prefixes ("userId",prefix) values ($1,$2)', [id, prefix])
    }
    await seedFixtureWorkspace(pool, owner, 'personal', personalWorkspace)
    await workspacePool.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,$3)', [workspace, owner, 'Telegram wire fixture'])
    for (const userId of [owner, other]) await workspacePool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,$4,$5)', [workspace, userId, userId + '@example.invalid', 'member', 'active'])
    await workspacePool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,$4,$5)', [team, workspace, owner, 'Telegram wire fixture', 'TGREAD'])
    for (const [id, userId, number] of [[mine, owner, 101], [mineLinked, owner, 102], [otherLinked, other, 201], [mineUnlinked, owner, 103]] as const) {
      await pool.query('insert into issues (id,"userId",title,content,status,priority,scope,"workspaceId") values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, userId, 'Telegram wire task', JSON.stringify({ type: 'doc', attrs: { mikka: { number } }, content: [] }), 'todo', 'normal', id === mine ? 'personal' : 'workspace', id === mine ? personalWorkspace : workspace])
    }
    for (const [issueId, userId] of [[mineLinked, owner], [otherLinked, other]]) await workspacePool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [issueId, team, workspace, userId])
    await pool.query('insert into telegram_links ("userId","telegramUserId") values ($1,$2)', [owner, telegramUserId])
    const sharedSearch = () => searchIssues(db, { userId: owner, workspaceId: workspace, params: parseSearchParams(new URLSearchParams({ q: 'Telegram wire task' })) })
    const { handleTelegramDirectMessage } = await import('../lib/telegram/handler')
    const telegram = async (text: string) => {
      const replies: string[] = []
      await handleTelegramDirectMessage(
        { id: threadId, isDM: true, post: async (reply: string) => { replies.push(reply) } } as unknown as Parameters<typeof handleTelegramDirectMessage>[0],
        { text, author: { userId: telegramUserId, userName: 'CI', isBot: false, isMe: false },
          raw: { message_id: 1, chat: { type: 'private' }, from: { language_code: 'en' } } } as unknown as Parameters<typeof handleTelegramDirectMessage>[1])
      return replies.join('\n')
    }
    // Telegram has no workspace selection: its trusted Coordinator is Personal.
    const sharedBefore = await sharedSearch()
    assert.equal(sharedBefore.items.find(row => row.id === mineUnlinked)?.identifier, 'TLGX-103')
    assert.match(sharedBefore.items.find(row => row.id === mineLinked)?.identifier ?? '', /^TGREAD-[1-9]\d*$/)
    assert.equal(sharedBefore.items.some(row => row.id === mine), false)
    await telegram('/issues')
    const mixed = await measured(() => telegram('/issues'))
    const lookup = await measured(() => telegram('/link TLGX-101'))
    await workspacePool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [mineUnlinked, team, workspace, owner])
    const linked = await measured(() => telegram('/issues'))
    assert.match((await sharedSearch()).items.find(row => row.id === mineUnlinked)?.identifier ?? '', /^TGREAD-[1-9]\d*$/)
    await workspacePool.query('delete from mikka_team_issues where "issueId"=$1', [mineUnlinked])
    await workspacePool.query('update mikka_workspace_members set status=$3 where "workspaceId"=$1 and "userId"=$2', [workspace, owner, 'suspended'])
    const revoked = await measured(() => telegram('/issues'))
    t.diagnostic(JSON.stringify({ event: 'telegram_identifier_transport', mixed: readMetrics(mixed), lookup: readMetrics(lookup), linked: readMetrics(linked), revoked: readMetrics(revoked) }))
    assert.match(mixed.value, /TLGX-101/)
    assert.doesNotMatch(mixed.value, /TGREAD-|TLGX-102|TLGX-103|OTHR-201/)
    assert.match(lookup.value, /TLGX-101/)
    assert.match(linked.value, /TLGX-101/)
    assert.doesNotMatch(linked.value, /TGREAD-|TLGX-102|TLGX-103|OTHR-201/)
    assert.match(revoked.value, /TLGX-101/)
    assert.doesNotMatch(revoked.value, /TGREAD-|TLGX-102|TLGX-103|OTHR-201/)
    assert.deepEqual((await sharedSearch()).items, [], 'revocation hides all tasks in the shared tenant')
    assert.doesNotMatch(await telegram(`/link ${mineLinked}`), /TGREAD-|Telegram wire task/, 'a direct Shared UUID cannot widen Telegram Personal access')
    await telegram('/new Telegram trusted-workspace fixture')
    await telegram('/confirm')
    const created = (await pool.query('select "workspaceId","ownershipState" from issues where "userId"=$1 and title=$2', [owner, 'Telegram trusted-workspace fixture'])).rows
    assert.deepEqual(created, [{ workspaceId: personalWorkspace, ownershipState: 'bound' }], 'Telegram creation uses the server-resolved Personal Coordinator workspace')
    assert.doesNotMatch(JSON.stringify([mixed.value, lookup.value, linked.value, revoked.value]), /prefixInput|__mikkaIdentifierPrefix|identifierTeams?|@example\.invalid/)
    // Actual old 3c32675c measurements of these same four calls and fixtures.
    for (const [label, current, statements, totalBytes] of [
      ['mixed', mixed, 14, 8820], ['lookup', lookup, 13, 7209],
      ['linked', linked, 14, 9147], ['revoked', revoked, 11, 6312],
    ] as const) {
      await t.test(label + ' keeps its frozen original Telegram read budget', () => {
        assert.ok(current.statements <= statements, label + ' exceeds the original statement count')
        assert.ok(current.bytes + current.bytesWritten <= totalBytes, label + ' exceeds the original total socket bytes')
      })
    }
  } finally {
    translations.restore()
    // Retain only synthetic fixture rows for the paired old/new wire review.
  }
})

test('identifier reads reuse current owner inputs across mixed workspace batches', { skip: !authorized }, async t => {
  const { db, pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { issues } = await import('../lib/db/schema')
  const { inArray, sql } = await import('drizzle-orm')
  const { taskIdentifiers, taskPrefixInput, pageTaskPrefixInput } = await import('../lib/task-identifier-server')
  const { parseSearchParams, searchIssues } = await import('../lib/issue-search')
  const owner = `identifier-read-owner-${randomUUID()}`, other = `identifier-read-other-${randomUUID()}`
  const workspace = randomUUID(), personalWorkspace = randomUUID(), otherPersonalWorkspace = randomUUID(), personalMine = randomUUID(), team = randomUUID()
  const mine = randomUUID(), theirs = randomUUID(), mineLinked = randomUUID(), theirsLinked = randomUUID()
  const ids = [mine, theirs, mineLinked, theirsLinked]
  let restoreTranslations: (() => void) | undefined
  try {
    for (const [id, prefix] of [[owner, 'AAAA'], [other, 'BBBB']]) {
      await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
      await pool.query('insert into issue_prefixes ("userId",prefix) values ($1,$2)', [id, prefix])
    }
    await seedFixtureWorkspace(pool, owner, 'personal', personalWorkspace)
    await seedFixtureWorkspace(pool, other, 'personal', otherPersonalWorkspace)
    await workspacePool.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,\'Identifier reads CI\')', [workspace, owner])
    for (const userId of [owner, other]) await workspacePool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'member\',\'active\')', [workspace, userId, `${userId}@example.invalid`])
    await workspacePool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Identifier reads CI\',\'IDREAD\')', [team, workspace, owner])
    for (const [id, userId, number] of [[mine, owner, 101], [theirs, other, 201], [mineLinked, owner, 102], [theirsLinked, other, 202]] as const) {
      const title = 'identifier-read-fixture ' + (id === mine ? 'idread-mixed' : id === mineLinked ? 'idread-linked' : id === theirsLinked ? 'idread-mixed idread-linked' : 'private')
      await pool.query('insert into issues (id,"userId",title,content,status,priority,scope,"workspaceId") values ($1,$2,$3,$4,\'todo\',\'normal\',$5,$6)', [id, userId, title, JSON.stringify({ type: 'doc', attrs: { mikka: { number, ...(id === mineLinked ? { __mikkaIdentifierPrefix: ['EVIL', 'forged@example.invalid', []] } : {}) } }, content: [] }), id === theirs ? 'personal' : 'workspace', id === theirs ? otherPersonalWorkspace : workspace])
    }
    for (const [id, userId] of [[mineLinked, owner], [theirsLinked, other]]) await workspacePool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id, team, workspace, userId])
    await pool.query('update issues set "updatedAt"=now()+interval \'1 minute\' where id=$1', [mine])
    const search = (userId: string, q = 'identifier-read-fixture', workspaceId = workspace) => searchIssues(db, { userId, workspaceId, params: parseSearchParams(new URLSearchParams({ q })) })
    await t.test('bounded numbering facts keep exact workspace membership and the one-query empty-membership budget', async () => {
      const { issueVisibility } = await import('../lib/issue-visibility')
      const { numberedIssueTeamScope, issueTeamAccess } = await import('../lib/issue-team-access')
      const { accessibleTeamScopes } = await import('../lib/team-access')
      const compare = async (known = false) => {
        const teams = known ? await accessibleTeamScopes(owner) : undefined
        const prior = await issueVisibility(owner, false, undefined, db, { onlyIssueIds: ids, teams })
        const scope = await measured(() => numberedIssueTeamScope(owner, ids, { teams }))
        assert.equal(scope.statements, 1, 'bounded membership and complete link facts use one workspace query')
        assert.deepEqual(scope.value.allowed.map(link => link.issueId).sort(), [...prior.allowedIds].sort())
        assert.equal(scope.value.taskTeams.has(mine), false, 'unlinked owner tasks remain absent from the complete number map')
        assert.match(scope.value.taskTeams.get(mineLinked)?.key ?? '', /^IDREAD$/)
        return scope.value
      }
      await compare()
      await compare(true)
      const empty = await measured(() => numberedIssueTeamScope(owner, []))
      assert.equal(empty.statements, 0)
      assert.equal(empty.value.taskTeams.size, 0)
      const otherWorkspace = randomUUID()
      await workspacePool.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,$3)', [otherWorkspace, owner, 'Exact membership fixture'])
      await workspacePool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,$4,$5)', [otherWorkspace, owner, owner + '@example.invalid', 'member', 'active'])
      try {
        await workspacePool.query('update mikka_team_issues set "workspaceId"=$2 where "issueId"=$1', [theirsLinked, otherWorkspace])
        assert.equal((await compare()).allowed.some(link => link.issueId === theirsLinked), false, 'a team id alone never admits a foreign-workspace link')
        await compare(true)
        const memberOnly = await measured(() => numberedIssueTeamScope(owner, [theirsLinked], { withWorkspaceMembership: true }))
        assert.equal(memberOnly.statements, 1)
        const legacyAccess = await issueTeamAccess(theirsLinked, owner)
        assert.equal(legacyAccess.allowed, true, 'the original Telegram link check uses the link workspace membership')
        assert.equal(memberOnly.value.workspaceMemberAllowed?.has(theirsLinked), legacyAccess.allowed)
        assert.equal(memberOnly.value.allowed.some(link => link.issueId === theirsLinked), false, 'the private membership fact never widens scope visibility')
        await workspacePool.query('update mikka_team_issues set "workspaceId"=$2 where "issueId"=$1', [theirsLinked, workspace])
        await workspacePool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspace, owner])
        const revoked = await compare()
        assert.equal(revoked.allowed.length, 0)
        assert.equal(revoked.taskTeams.has(mineLinked), true, 'revocation preserves a private naming fact without granting workspace access')
        await compare(true)
        const revokedMembership = await measured(() => numberedIssueTeamScope(owner, [mineLinked], { withWorkspaceMembership: true }))
        assert.equal(revokedMembership.statements, 1)
        assert.equal(revokedMembership.value.workspaceMemberAllowed?.has(mineLinked), (await issueTeamAccess(mineLinked, owner)).allowed)
      } finally {
        await workspacePool.query('update mikka_team_issues set "workspaceId"=$2 where "issueId"=$1', [theirsLinked, workspace])
        await workspacePool.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1 and "userId"=$2', [workspace, owner])
        await workspacePool.query('delete from mikka_workspace_members where "workspaceId"=$1', [otherWorkspace])
        await workspacePool.query('delete from mikka_workspaces where id=$1', [otherWorkspace])
      }
    })
    // This assertion uses only existing public functions. It reproduces the
    // old extra prefix read before exercising any newly added projection API.
    await search(owner, 'idread-mixed')
    await search(owner, 'idread-linked')
    const firstMixed = await measured(() => search(owner, 'idread-mixed'))
    const firstLinked = await measured(() => search(owner, 'idread-linked'))
    assert.equal(firstMixed.statements, firstLinked.statements, 'one unlinked workspace row must not add a database round trip')
    const columns = { id: issues.id, ownerId: issues.userId, scope: issues.scope, number: sql<number>`(issues.content->'attrs'->'mikka'->>'number')::int`.as('number') }
    const plain = () => db.select(columns).from(issues).where(inArray(issues.id, ids))
    const withInputs = async () => {
      const page = db.select({ ...columns, prefixOwner: sql<string>`issues."userId"`.as('prefixOwner') }).from(issues).where(inArray(issues.id, ids)).as('identifier_page')
      return db.select({ id: page.id, ownerId: page.ownerId, scope: page.scope, number: page.number,
        prefixInput: pageTaskPrefixInput(sql`identifier_page."prefixOwner"`, sql`identifier_page.id`) }).from(page)
    }
    // The two queries execute against the real, separately configured pools.
    // The control deliberately omits the same-operation inputs, preserving
    // the former team-then-owner lookup, with no SQL-text instrumentation.
    const control = await measured(async () => Object.fromEntries(await taskIdentifiers(await plain())))
    const reused = await measured(async () => Object.fromEntries(await taskIdentifiers(await withInputs())))
    assert.deepEqual(reused.value, control.value)
    assert.equal(reused.value[mine], 'AAAA-101')
    assert.equal(reused.value[theirs], 'BBBB-201', 'each correlated input belongs to its own outer owner')
    assert.match(reused.value[mineLinked]!, /^IDREAD-[1-9]\d*$/)
    assert.match(reused.value[theirsLinked]!, /^IDREAD-[1-9]\d*$/)
    assert.equal(reused.statements, control.statements - 1, 'mixed workspace naming adds no separate prefix round trip')
    assert.ok(reused.resultBytes <= control.resultBytes, JSON.stringify({ reused: readMetrics(reused), control: readMetrics(control) }))
    // A single-row projection must use the same qualified owner correlation.
    const projected = await db.select({ ownerId: issues.userId, prefixInput: taskPrefixInput(sql`issues."userId"`) }).from(issues).where(inArray(issues.id, [mine, theirs]))
    assert.deepEqual(new Map(projected.map(row => [row.ownerId, row.prefixInput?.[0]])), new Map([[owner, 'AAAA'], [other, 'BBBB']]))
    const mixed = await measured(() => search(owner))
    assert.deepEqual(new Set(mixed.value.items.map(row => row.id)), new Set([mine, mineLinked, theirsLinked]))
    assert.equal(mixed.value.items.find(row => row.id === mine)?.identifier, 'AAAA-101')
    assert.equal((await search(other, 'identifier-read-fixture', otherPersonalWorkspace)).items.find(row => row.id === theirs)?.identifier, 'BBBB-201')
    assert.ok(!JSON.stringify(mixed.value).includes('@example.invalid'))
    assert.ok(!JSON.stringify(mixed.value).includes('prefixInput'))
    const { listArtifacts } = await import('../lib/artifacts/store')
    const artifactIds: string[] = []
    for (const issueId of ids) {
      const id = randomUUID()
      artifactIds.push(id)
      await pool.query('insert into artifacts (id,"userId",kind,title,"issueId","latestVersion") values ($1,$2,\'markdown\',\'Identifier read artifact\',$3,1)', [id, owner, issueId])
      await pool.query('insert into artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") values ($1,$2,1,$3,\'fixture\',\'fixture\',7,\'CI\')', [randomUUID(), id, `ci/identifier-read/${id}.md`])
    }
    const artifactMixed = await measured(() => listArtifacts(owner))
    assert.equal(artifactMixed.value.find(row => row.issueId === mine)?.issueKey, 'AAAA-101')
    assert.equal(artifactMixed.value.some(row => row.issueId === theirs), false, 'artifact creator ownership does not expose another owner\'s Personal tenant')
    assert.match(artifactMixed.value.find(row => row.issueId === theirsLinked)?.issueKey ?? '', /^IDREAD-[1-9]\d*$/)
    // Standalone Node has no Next intl-config alias. Use the real translator
    // and repository catalog at this UI boundary; database/naming code stays real.
    const { createTranslator } = await import('use-intl/core')
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8'))
    const translations = mock.module('next-intl/server', { namedExports: {
      getLocale: async () => 'en',
      getTranslations: async () => createTranslator({ locale: 'en', messages, namespace: 'TelegramBot' }),
    } })
    restoreTranslations = () => translations.restore()
    // Keep the Shared search matrix above; Telegram independently resolves
    // this account's Personal Coordinator and cannot read those Shared rows.
    await pool.query('insert into issues (id,"userId","workspaceId",title,content,status,priority,scope) values ($1,$2,$3,$4,$5,\'todo\',\'normal\',\'personal\')',
      [personalMine, owner, personalWorkspace, 'Telegram Personal numbering control', JSON.stringify({ type: 'doc', attrs: { mikka: { number: 103 } }, content: [] })])
    const { handleTelegramDirectMessage } = await import('../lib/telegram/handler')
    const telegramUserId = `identifier-read-${randomUUID()}`, threadId = `telegram:${randomUUID()}`
    await pool.query('insert into telegram_links ("userId","telegramUserId") values ($1,$2)', [owner, telegramUserId])
    const telegram = async (text: string) => {
      const replies: string[] = []
      await handleTelegramDirectMessage(
        { id: threadId, isDM: true, post: async (reply: string) => { replies.push(reply) } } as unknown as Parameters<typeof handleTelegramDirectMessage>[0],
        { text, author: { userId: telegramUserId, userName: 'CI', isBot: false, isMe: false },
          raw: { message_id: 1, chat: { type: 'private' }, from: { language_code: 'en' } } } as unknown as Parameters<typeof handleTelegramDirectMessage>[1])
      return replies.join('\n')
    }
    await telegram('/issues') // Create the conversation outside the measured read.
    const telegramMixed = await measured(() => telegram('/issues'))
    assert.match(telegramMixed.value, /AAAA-103/)
    assert.doesNotMatch(telegramMixed.value, /AAAA-101|IDREAD-|BBBB-201|@example\.invalid/)
    assert.match(await telegram('/link AAAA-103'), /AAAA-103/)
    assert.doesNotMatch(await telegram(`/link ${mine}`), /AAAA-101|identifier-read-fixture/, 'a Shared UUID stays outside Telegram Personal access')
    assert.match(await telegram('/status'), /AAAA-103/)
    await pool.query('update issue_prefixes set prefix=\'CCCC\' where "userId"=$1', [owner])
    assert.equal((await search(owner)).items.find(row => row.id === mine)?.identifier, 'CCCC-101', 'inputs are read anew in this operation')
    assert.equal((await search(other, 'identifier-read-fixture', otherPersonalWorkspace)).items.find(row => row.id === theirs)?.identifier, 'BBBB-201')
    await pool.query('update issues set "updatedAt"=now()+interval \'1 minute\' where id=$1', [mineLinked])
    await workspacePool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspace, owner])
    assert.match(await telegram('/issues'), /CCCC-103/, 'Shared membership revocation does not remove the Personal Coordinator task')
    assert.deepEqual((await search(owner)).items, [], 'a creator cannot retain Shared search access through an unlinked task')
    await workspacePool.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1 and "userId"=$2', [workspace, owner])
    await workspacePool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [mine, team, workspace, owner])
    const allLinked = await measured(() => search(owner))
    assert.equal(mixed.statements, allLinked.statements, 'an unlinked row does not add a query to a workspace-only page')
    const artifactLinked = await measured(() => listArtifacts(owner))
    const telegramLinked = await measured(() => telegram('/issues'))
    assert.ok(artifactMixed.statements <= 4 && artifactLinked.statements <= 5, 'artifact task keys stay within the fixed identifier read budget')
    assert.ok(telegramMixed.statements <= 14 && telegramLinked.statements <= 14, 'Telegram retains the frozen exact-access budget while excluding Shared tasks')
    console.log('Artifact/Telegram identifier read traffic:', JSON.stringify({ artifactIds, threadId, telegramUserId,
      artifactMixed: readMetrics(artifactMixed), artifactLinked: readMetrics(artifactLinked),
      telegramMixed: readMetrics(telegramMixed), telegramLinked: readMetrics(telegramLinked) }))

    console.log('Identifier-read synthetic traffic:', JSON.stringify({ control: readMetrics(control), reused: readMetrics(reused), mixedSearch: readMetrics(mixed), linkedSearch: readMetrics(allLinked) }))
  } finally {
    restoreTranslations?.()
    console.log('Identifier-read fixture retention audit:', JSON.stringify({ recordedAt: new Date().toISOString(), retention: 'preserve', owner, other, workspace, personalWorkspace, otherPersonalWorkspace, personalMine, team, ids }))
  }
})
