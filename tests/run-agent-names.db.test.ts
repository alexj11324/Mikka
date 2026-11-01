// R-78 against a real PostgreSQL: what a run did is credited to its Agent
// (Claude Code, Codex), never the Bot that dispatched it.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedBot, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('run work is credited to its Agent', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })

  const owner = await seedUser(pool, 'owner')
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const bot = await seedBot(pool, ws.id, owner, '后端值班')
  const codex = await seedAgent(pool, owner, 'codex')
  const run = await seedRun(pool, { userId: owner, agentId: codex, botId: bot, status: 'running' })

  await t.test('a run hands an artifact over as its Agent', async () => {
    const { runSubmitter } = await import('../lib/mcp/artifacts')
    assert.equal((await runSubmitter({ id: run, userId: owner, botId: bot, issueId: null })).authorName, 'Codex')
  })

  await t.test('older versions stored under the dispatching Bot still read as the Agent; a bot author stays a bot', async () => {
    const { listArtifacts, readArtifact } = await import('../lib/artifacts/store')
    const fromRun = randomUUID(), fromBot = randomUUID()
    await pool.query('insert into artifacts (id,"userId",kind,title,"runId","latestVersion") values ($1,$2,\'markdown\',\'From the run\',$3,1),($4,$2,\'markdown\',\'From the bot\',null,1)', [fromRun, owner, run, fromBot])
    for (const [artifactId, author] of [[fromRun, '后端值班'], [fromBot, '后端值班']]) {
      await pool.query('insert into artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") values ($1,$2,1,$3,\'x\',\'0\',1,$4)', [randomUUID(), artifactId, `test/${artifactId}`, author])
    }
    const runVersion = (await readArtifact(owner, fromRun))!.versions[0]
    assert.deepEqual([runVersion.authorName, runVersion.authorHarness, runVersion.authorColor], ['Codex', 'codex', null])
    const botVersion = (await readArtifact(owner, fromBot))!.versions[0]
    assert.deepEqual([botVersion.authorName, botVersion.authorHarness, botVersion.authorColor], ['后端值班', null, 'encre'])
    const listed = await listArtifacts(owner)
    assert.deepEqual(listed.map(item => [item.title, item.authorName]).sort(), [['From the bot', '后端值班'], ['From the run', 'Codex']])
  })

  await t.test('an activity row written with a run token names the Agent', async () => {
    const { enrichActivityActors } = await import('../lib/activity-actor-server')
    const [row] = await enrichActivityActors([{ actorType: 'agent' as const, actorId: codex }], owner)
    assert.equal(row.actor?.name, 'Codex')
  })
})
