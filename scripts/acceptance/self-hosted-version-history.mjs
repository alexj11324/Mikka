import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Only pre-existing history is seeded. The installed client creates every
// version and result Run through the same writer used by ordinary threads.
export async function prepareDesktopVersionHistory(pool, ownerId, workspaceId, createTask) {
  const device = randomUUID(), agent = randomUUID(), repository = randomUUID()
  const remote = 'https://github.com/example/desktop-qa'
  const originals = []
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal((await client.query('SHOW server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    await client.query(`INSERT INTO devices(id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses)
      VALUES ($1,$2,'Desktop history fixture','local',true,now(),$3)`,
    [device, ownerId, JSON.stringify([{ harness: 'codex', installed: true, toolApproval: true }])])
    await client.query(`INSERT INTO agents(id,"userId","deviceId",name,harness)
      VALUES ($1,$2,$3,'Desktop history fixture','codex')`, [agent, ownerId, device])
    await client.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl")
      VALUES ($1,$2,$3,'v2/github.com/example/desktop-qa',$4)`, [repository, device, ownerId, remote])
    for (const operation of ['edit', 'rerun']) {
      const issueId = await createTask(operation), runId = randomUUID(), messageId = randomUUID()
      const originalText = 'Original desktop ' + operation + ' instruction'
      const originalOutput = 'Original desktop ' + operation + ' answer'
      const originalPullRequest = remote + '/pull/18'
      await client.query(`INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId","deviceId","deviceRepoId",
        title,"titleSource",status,"startedAt","finishedAt","lastReply",prompt,"agentDefinition")
        VALUES ($1,$2,$3,$4,$5,$6,$7,'Desktop history fixture','manual','succeeded',
        now()-interval '5 minutes',now()-interval '1 minute',$8,$9,$10)`,
      [runId,ownerId,workspaceId,issueId,agent,device,repository,originalOutput,'Initial desktop task brief',
        JSON.stringify({harness:'codex',model:'selfhost-ci',modelSource:'native-default',readOnly:true})])
      await client.query(`INSERT INTO run_messages(id,"runId","userId",text,origin,"deliveredAt","createdAt")
        VALUES ($1,$2,$3,$4,'owner',now()-interval '4 minutes',now()-interval '4 minutes')`,
      [messageId,runId,ownerId,originalText])
      const answerId = randomUUID()
      await client.query(`INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt")
        VALUES ($1,$2,1,$3,now()-interval '3 minutes')`,
      [randomUUID(),runId,JSON.stringify({type:'text-delta',id:answerId,delta:originalOutput})])
      await client.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest")
        VALUES ($1,$2,$3,$4,'v2/github.com/example/desktop-qa','published',$5)`,
      [runId,ownerId,issueId,remote,JSON.stringify({url:originalPullRequest})])
      originals.push({operation,issueId,runId,anchorKey:operation === 'edit' ? messageId : answerId,
        originalText,originalOutput,originalPullRequest})
    }
    await client.query('COMMIT')
    return originals
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function verifyDesktopVersionAdmissions(query, receipts) {
  assert.deepEqual(receipts.map(r => r.operation), ['edit','rerun'])
  for (const {operation,issueId,runId,versionId,resultRunId} of receipts) {
    const {rows} = await query.query(`SELECT v.id AS version, result.id AS result, result."continuesRunId" AS original,
      (SELECT count(*)::int FROM agent_runs WHERE "issueId" = $1) AS runs,
      (SELECT count(*)::int FROM thread_reply_versions WHERE "rootRunId"=$2) AS versions
      FROM thread_reply_versions v JOIN agent_runs result ON result.id=v."resultRunId"
      JOIN agent_runs root ON root.id=v."rootRunId" AND root."userId"=result."userId"
        AND root."workspaceId"=result."workspaceId" AND root."issueId"=result."issueId"
      WHERE root.id=$2 AND root."issueId"=$1 AND v.id=$3 AND v.operation=$4`,
    [issueId,runId,versionId,operation])
    assert.deepEqual(rows,[{version:versionId,result:resultRunId,original:runId,runs:2,versions:1}])
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { assertFixtureEnvironment } = await import('./self-hosted-services.mjs')
  assertFixtureEnvironment(process.env)
  const report = JSON.parse(readFileSync(0,'utf8'))
  assert.equal(report.scope,'complete-desktop')
  assert.equal(report.status,'passed')
  assert.equal(report.revision,process.env.MIKKA_EXPECTED_REVISION)
  assert.match(report.overlaySha,/^[a-f0-9]{40}$/)
  const { Pool } = await import('pg')
  const pool = new Pool({connectionString:process.env.MIKKA_DATABASE_URL,max:1})
  try { await verifyDesktopVersionAdmissions(pool,report.versionAdmissions) }
  finally { await pool.end() }
  console.log('Desktop edit and rerun each admitted exactly one durable result Run.')
}
