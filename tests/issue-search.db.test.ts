import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const url = process.env.E2E_DATABASE_URL
const authorized = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && url
if (url && (!authorized || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/mikka_e2e')) throw new Error('Search DB tests require GitHub CI ephemeral mikka_e2e')
if (process.env.REQUIRE_DB === '1' && !authorized) throw new Error('Search DB tests cannot skip in required CI')

test('indexed, owner-safe relation search beyond 101 tasks, paging and graph visibility', {skip: !authorized}, async () => {
  const {Pool} = await import('pg')
  const pool = new Pool({connectionString: url,max:2})
  const {db} = await import('../lib/db')
  const {parseSearchParams,searchIssues} = await import('../lib/issue-search')
  const owner = `search-owner-${randomUUID()}`, viewer = `search-viewer-${randomUUID()}`
  const workspace = randomUUID(), otherWorkspace = randomUUID(), team = randomUUID()
  const root = randomUUID(), child = randomUUID(), hidden = randomUUID()
  const params = (query: Record<string,string>) => parseSearchParams(new URLSearchParams(query))
  const search = (query: Record<string,string>, userId = owner, workspaceId = workspace) => searchIssues(db,{userId,workspaceId,params:params(query)})
  try {
    for (const file of ['20261025020250_issue_search_pg_trgm.sql','20261025020251_issue_search_title_idx.sql','20261025020252_issue_search_recent_idx.sql','20261025020253_issue_search_number_idx.sql']) {
      const text = await readFile(new URL(`../drizzle/${file}`,import.meta.url),'utf8')
      await pool.query(text)
      await pool.query(text) // idempotent migration replay, outside transactions
    }
    const indexes = await pool.query("select indexrelid::regclass::text name,indisvalid from pg_index where indexrelid::regclass::text like 'issues_%search%' or indexrelid::regclass::text='issues_owner_updated_id_idx'")
    assert.ok(indexes.rows.length>=3)
    assert.ok(indexes.rows.every(row=>row.indisvalid))
    for (const id of [owner,viewer]) await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())',[id,`${id}@example.invalid`])
    for (const [w,u] of [[workspace,owner],[otherWorkspace,viewer]]) await pool.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,\'Search CI\')',[w,u])
    for (const [w,u] of [[workspace,owner],[workspace,viewer],[otherWorkspace,viewer]]) await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'member\',\'active\')',[w,u,`${u}@example.invalid`])
    await pool.query('insert into orvilo_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Search CI\',\'SCI\')',[team,workspace,owner])
    // >100 recent rows cannot hide an older keyword match. Large synthetic
    // dataset also makes the real planner choice observable without prod data.
    await pool.query(`insert into issues (id,"userId",title,content,status,priority,scope,"updatedAt")
      select gen_random_uuid(),$1,'CI haystack '||g,jsonb_build_object('type','doc','attrs',jsonb_build_object('mikka',jsonb_build_object('number',g))),'todo','none','personal',now() from generate_series(1,12000) g`,[owner])
    const add = async (id:string,title:string,scope='personal',meta:Record<string,unknown>={}) => pool.query('insert into issues (id,"userId",title,content,status,priority,scope,"updatedAt") values ($1,$2,$3,$4,\'todo\',\'none\',$5,\'2020-01-01T00:00:00.123456Z\')',[id,owner,title,JSON.stringify({type:'doc',attrs:{mikka:{number:14000,...meta}},content:[]}),scope])
    await add(root,'rare-needle 修复 50%_off')
    await add(child,'child rare-needle','personal',{parentId:root,number:14001})
    await add(hidden,'private rare-needle','personal',{parentId:root,number:14002})
    await pool.query('insert into issue_members ("issueId","userId","memberId") values ($1,$2,$3)',[hidden,owner,viewer])
    await pool.query('insert into orvilo_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[hidden,team,workspace,owner])
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
    // One row is changed to a team-visible task, but never visible in another
    // workspace nor after suspension. Owner-only personal rows remain hidden.
    await pool.query('update issues set scope=\'workspace\' where id=$1',[hidden])
    assert.deepEqual((await search({q:'rare-needle'},viewer)).items.map(x=>x.id),[hidden])
    assert.equal((await search({q:'rare-needle'},viewer,otherWorkspace)).items.length,0)
    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2',[workspace,viewer])
    assert.equal((await search({q:'rare-needle'},viewer)).items.length,0)
    // Bulk fixture inserts leave GIN fast-update entries in its pending list.
    // Flush as normal vacuum would before measuring steady-state planner cost;
    // do not disable sequential scans or force an index plan.
    await pool.query("select gin_clean_pending_list('issues_title_search_trgm_idx'::regclass)")
    await pool.query('analyze issues')
    const plan=await pool.query('explain (analyze,buffers,format json) select id from issues where "userId"=$1 and title ilike $2 order by "updatedAt" desc,id desc limit 21',[owner,'%rare-needle%'])
    console.log('CI synthetic selective title EXPLAIN:',JSON.stringify(plan.rows[0]['QUERY PLAN']))
    assert.match(JSON.stringify(plan.rows[0]['QUERY PLAN']),/issues_title_search_trgm_idx/)
  } finally {
    await pool.query('delete from issue_members where "userId"=$1',[owner])
    await pool.query('delete from orvilo_team_issues where "userId"=$1',[owner])
    await pool.query('delete from issues where "userId"=$1',[owner])
    await pool.query('delete from orvilo_teams where id=$1',[team])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=any($1::uuid[])',[[workspace,otherWorkspace]])
    await pool.query('delete from mikka_workspaces where id=any($1::uuid[])',[[workspace,otherWorkspace]])
    await pool.query('delete from "user" where id=any($1::text[])',[[owner,viewer]])
    await pool.end()
  }
})
