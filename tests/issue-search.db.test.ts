import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'

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
