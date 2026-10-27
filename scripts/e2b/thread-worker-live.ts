/** Isolated PostgreSQL and two disposable E2B machines. The mock device
 * service and repository contain only synthetic data and no provider tokens. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { Sandbox } from 'e2b'
import { prepareWorkspaceSnapshot } from '../../lib/computer/workspace-snapshot'
import { ThreadMachines } from '../../lib/computer/thread-machine'
import { startThreadWorker } from '../../lib/computer/thread-worker'
import { threadMachineProvider } from '../../lib/computer/e2b-provider'

async function main() {
  const url = new URL(process.env.COMPUTER_TEST_DATABASE_URL ?? '')
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname))
  const template = process.env.E2B_COMPUTER_TEMPLATE, sha = process.env.E2B_WORKER_SHA
  if (!template || !process.env.E2B_API_KEY || !sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Disposable template and worker revision required')
  const sourceTemplate = process.env.E2B_SOURCE_TEMPLATE ?? template, sourceSha = process.env.E2B_SOURCE_SHA ?? sha
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Invalid source worker revision')
  const options = { apiKey: process.env.E2B_API_KEY, proxy: process.env.HTTPS_PROXY, timeoutMs: 360_000 }
  const schema = `threadworker_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` })
  let source: Sandbox | undefined, threadId: string | undefined, snapshotId: string | undefined, finished = false
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('synthetic-owner');
      CREATE TABLE bots (id uuid PRIMARY KEY,"workspaceId" uuid,"ownerId" text,UNIQUE(id,"workspaceId","ownerId"));
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"agentId" uuid,status text,"stopRequestedAt" timestamptz,"startedAt" timestamptz,"deviceId" uuid);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY,"botId" uuid,"workspaceId" uuid,"ownerId" text);
      CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,name text,kind text,enabled boolean DEFAULT true,"lastSeenAt" timestamptz,harnesses jsonb);
      CREATE TABLE device_tokens (id uuid PRIMARY KEY,"userId" text,name text,"tokenHash" text,"boundDeviceId" uuid,"boundWorkspaceId" uuid,"expiresAt" timestamptz,"lastUsedAt" timestamptz,"revokedAt" timestamptz,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE cloud_machines ("workspaceId" uuid,"ownerId" text,"sandboxId" text,state text);
      CREATE TABLE workspace_computer_policies ("workspaceId" uuid,permission text);
      CREATE TABLE bot_cloud_runtimes ("botId" uuid,"workspaceId" uuid,"ownerId" text,"agentId" uuid,"repoId" uuid);
      CREATE TABLE device_repos (id uuid,"userId" text,"repoPath" text)`)
    for (const name of ['20261027180000_thread_machines_and_bot_subagents.sql', '20261027180002_thread_worker_leases.sql', '20261027180003_workspace_snapshot_versions.sql', '20261027180004_thread_results.sql']) {
      await pool.query(await readFile(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'))
    }
    const actor = { userId: 'synthetic-owner', workspaceId: randomUUID() }, botId = randomUUID(), runId = randomUUID(), agentId = randomUUID(), repoId = randomUUID()
    source = await Sandbox.create(sourceTemplate, options)
    assert.equal((await source.files.read('/opt/mikka/worker-source-sha', { user: 'root' })).trim(), sourceSha)
    const repo = `/home/mikka-runner/.mikka/bot-workspaces/${botId}`
    await source.commands.run(`install -d -o mikka-runner -g mikka-runner -m 0700 ${repo}`, { user: 'root' })
    await source.commands.run(`git -C ${repo} init -q -b main; printf 'thread fixture\n' > ${repo}/fixture.txt; git -C ${repo} add .; git -C ${repo} -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture`, { user: 'mikka-runner', timeoutMs: 30_000 })
    await pool.query('INSERT INTO bots VALUES ($1,$2,$3)', [botId, actor.workspaceId, actor.userId])
    await pool.query('INSERT INTO agent_runs (id,"userId","agentId",status) VALUES ($1,$2,$3,$4)', [runId, actor.userId, agentId, 'queued'])
    await pool.query('INSERT INTO computer_run_bindings VALUES ($1,$2,$3,$4)', [runId, botId, actor.workspaceId, actor.userId])
    await pool.query('INSERT INTO cloud_machines VALUES ($1,$2,$3,$4)', [actor.workspaceId, actor.userId, source.sandboxId, 'running'])
    await pool.query('INSERT INTO device_repos VALUES ($1,$2,$3)', [repoId, actor.userId, repo])
    await pool.query('INSERT INTO bot_cloud_runtimes VALUES ($1,$2,$3,$4,$5)', [botId, actor.workspaceId, actor.userId, agentId, repoId])
    await source.files.write('/tmp/mikka-mock-device-server.py', await readFile(new URL('./mock-device-server.py', import.meta.url), 'utf8'), { user: 'user' })
    await source.commands.run(`MIKKA_TEST_WORKSPACE=${actor.workspaceId} /usr/bin/python3 /tmp/mikka-mock-device-server.py >/tmp/mikka-mock-server.log 2>&1`, { user: 'user', background: true, timeoutMs: 0 })
    await source.commands.run('for i in $(seq 1 40); do [ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8765/)" = 401 ] && exit 0; sleep .25; done; exit 1', { user: 'user', timeoutMs: 15_000 })
    snapshotId = await prepareWorkspaceSnapshot(pool, actor, runId, botId, sha)
    threadId = await new ThreadMachines(pool, threadMachineProvider).wake(actor, runId)
    assert.notEqual(threadId, source.sandboxId)
    const thread = await Sandbox.connect(threadId, options)
    assert.equal((await thread.files.read('/workspace/fixture.txt', { user: 'mikka-runner' })).trim(), 'thread fixture')
    await thread.commands.run('test ! -e /home/mikka-runner/.mikka/worker/device.json', { user: 'root' })
    const service = source
    const observer = (async () => {
      while (!finished) {
        const raw = await service.files.read('/tmp/mikka-worker-registration.json', { user: 'root' }).catch(() => null)
        if (raw) {
          const marker = JSON.parse(raw) as { deviceId: string; hash: string; harnesses: unknown[] }
          const verified = await pool.query('UPDATE device_tokens SET "lastUsedAt"=now() WHERE "tokenHash"=$1 AND "boundDeviceId"=$2 AND "boundWorkspaceId"=$3 AND "revokedAt" IS NULL RETURNING id', [marker.hash, marker.deviceId, actor.workspaceId])
          if (verified.rowCount) await pool.query('UPDATE devices SET "lastSeenAt"=now(),harnesses=$2 WHERE id=$1', [marker.deviceId, JSON.stringify(marker.harnesses)])
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    })()
    try {
      const worker = await startThreadWorker(pool, actor, runId, thread, `https://${source.getHost(8765)}/mikka`, sha)
      const row = (await pool.query('SELECT "deviceId" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0]
      assert.equal(worker.deviceId, row.deviceId)
      await thread.commands.run('if test -r /home/mikka-runner/.mikka/worker/device.json; then exit 1; fi', { user: 'user' })
      console.log('live thread worker: isolated snapshot, scoped registration and private credential passed')
    } finally { finished = true; await observer }
    await pool.query('UPDATE agent_runs SET status=$2 WHERE id=$1', [runId, 'stopped'])
    await new ThreadMachines(pool, threadMachineProvider).end(actor, runId); threadId = undefined
  } finally {
    finished = true
    if (threadId) await Sandbox.kill(threadId, options).catch(() => undefined)
    if (source) await source.kill().catch(() => undefined)
    if (snapshotId) await Sandbox.deleteSnapshot(snapshotId, options).catch(() => undefined)
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
}
void main().catch(error => { console.error('Thread worker fixture failed:', error instanceof Error ? error.message : 'unknown'); process.exitCode = 1 })
