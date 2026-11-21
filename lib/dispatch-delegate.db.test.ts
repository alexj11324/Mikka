import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { eq } from 'drizzle-orm'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { assertE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from '../tests/helpers/task-workspace'
import { createTestDatabase, dropTestDatabase } from '../tests/support/drop-test-database'
import { observePoolCommits } from './db/commit-effects'
import { db, withDatabaseClient } from './db'
import { issues } from './db/schema'
import { admitDispatchDelegate } from './dispatch-delegate'
import { readIssueMetadata } from './issue-metadata'
import { persistIssueMetadata } from './issue-metadata-store'
import { userActor } from './activity-actor'

const url = process.env.E2E_DATABASE_URL
if (!url && process.env.REQUIRE_DB === '1') throw Error('An isolated delegate database is required')

test('an owner’s admitted dispatch initializes a delegate once and never rewrites a personal or historical decision', { skip: !url }, async () => {
  const base = assertE2eTarget(url!)
  const name = 'delegate_' + randomUUID().replaceAll('-','') + '_e2e'
  const admin = new Pool({connectionString:base.href,max:1})
  await createTestDatabase(admin,name,'template0')
  base.pathname = '/' + name
  const pool = new Pool({connectionString:base.href})
  observePoolCommits(pool)
  try {
    const dir = new URL('../drizzle/',import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file=>file.endsWith('.sql')))) await pool.query(await readFile(new URL(file,dir),'utf8'))
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES
      ('owner','Owner','owner@example.invalid',true,now(),now()),('peer','Peer','peer@example.invalid',true,now(),now())`)
    const workspace = await seedFixtureWorkspace(pool,'owner','team')
    const agent = randomUUID()
    await pool.query(`INSERT INTO agents(id,"userId",name,harness) VALUES ($1,'owner','Builder','codex')`,[agent])
    const seed = async (meta: Record<string,unknown>, version = 1) => {
      const id = randomUUID(), run = randomUUID()
      await pool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,revision)
        VALUES ($1,'owner',$2,'Keep this title',$3,'todo','normal',$4)`,[id,workspace,JSON.stringify({type:'doc',attrs:{mikka:meta},content:[{type:'paragraph',content:[{type:'text',text:'Keep the document'}]}]}),version])
      await pool.query(`INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId",status) VALUES ($1,'owner',$2,$3,$4,'queued')`,[run,workspace,id,agent])
      return {id,run}
    }
    const apply = async (task: {id:string;run:string}, user = 'owner', event?: string) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const initialize = await admitDispatchDelegate(client,user,task.id,event ? { eventId:event,botId:null } : undefined)
        const changed = initialize ? await initialize(task.run) : false
        await client.query('COMMIT')
        return changed
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    const first = await seed({delegate:null,delegateSelection:'dispatch'})
    assert.equal(await apply(first,'peer'),false)
    assert.equal(await apply(first,'owner',randomUUID()),false,'no verified source event')
    assert.deepEqual((await Promise.all([apply(first),apply(first)])).sort(),[false,true])
    const read = async () => (await pool.query('SELECT revision,content FROM issues WHERE id=$1',[first.id])).rows[0]
    const saved = await read()
    assert.equal(saved.revision,2)
    assert.equal(saved.content.content[0].content[0].text,'Keep the document')
    assert.deepEqual(readIssueMetadata(saved.content).delegate,{id:agent,name:'Builder',kind:'agent',image:null})
    const version = (await pool.query('SELECT actor_type,actor_id,revision FROM issue_versions WHERE "issueId"=$1',[first.id])).rows
    assert.deepEqual(version,[{actor_type:'agent',actor_id:agent,revision:2}])
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await withDatabaseClient(client,async () => {
        const [issue] = await db.select().from(issues).where(eq(issues.id,first.id)).for('update')
        await persistIssueMetadata(db,issue,{...readIssueMetadata(issue.content),delegate:null,delegateSelection:'manual'},userActor('owner'))
      })
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    assert.equal(await apply(first),false,'a late new admission preserves the manual clear')
    assert.equal(readIssueMetadata((await read()).content).delegate,null)
    assert.equal(await apply(await seed({delegate:null},4)),false,'historical null may have been deliberate')
    assert.equal(await apply(await seed({assignee:{kind:'agent',id:agent,name:'Legacy Agent',image:null}},3)),false)
    assert.equal(await apply(await seed({delegateSelection:'dispatch',assignee:{kind:'member',id:'peer',name:'Peer',image:null}})),false)
    assert.equal(await apply(await seed({})),true,'legacy task with no delegate property')
  } finally {
    await dropTestDatabase(admin,name,pool)
    await admin.end()
  }
})
