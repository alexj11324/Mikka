/** Disposable synthetic app + isolated loopback Postgres + real E2B worker.
 * This verifies startup and credential delivery, not product/provider login. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { Sandbox } from 'e2b'
import { ComputerStore } from '../../lib/computer/store'
import { startCloudWorker } from '../../lib/computer/cloud-worker'
import { queueCloudRun } from '../../lib/computer/queue-run'
import { ensureBotRuntime } from '../../lib/computer/bot-runtime'
import { bindBotSubscription } from '../../lib/computer/bot-subscription'
import { claimCloudRun } from '../../lib/computer/claim'
import { decideComputerReview, syncComputerReviews } from '../../lib/computer/reviews'
import { computerSyncBody } from '@mikka/protocol/computer'

let stage = 'initialize'
async function main() {
  const url = new URL(process.env.COMPUTER_TEST_DATABASE_URL ?? '')
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname))
  assert.ok(process.env.E2B_API_KEY && process.env.E2B_COMPUTER_TEMPLATE && /^[a-f0-9]{40}$/.test(process.env.E2B_WORKER_SHA ?? ''))
  const schema = `worker_live_${randomUUID().replaceAll('-', '')}`
  const connection = { apiKey: process.env.E2B_API_KEY, proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy }
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` })
  let sandbox: Sandbox | undefined
  try {
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES (\'synthetic-owner\')')
    await pool.query(await readFile(new URL('../../drizzle/20261027164501_cloud_computers.sql', import.meta.url), 'utf8'))
    await pool.query('CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, "issueId" uuid, "agentId" uuid, "botId" uuid REFERENCES bots(id), status text NOT NULL, kind text, prompt text, "baseBranch" text, "deviceRepoId" uuid, "deviceId" uuid, "startedAt" timestamptz, "finishedAt" timestamptz, "leaseExpiresAt" timestamptz, "updatedAt" timestamptz, "stopRequestedAt" timestamptz)')
    await pool.query('CREATE TABLE devices (id uuid PRIMARY KEY, "ownerId" text NOT NULL, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, harnesses jsonb NOT NULL DEFAULT \'[]\', "lastSeenAt" timestamptz); CREATE TABLE device_tokens (id uuid PRIMARY KEY, "userId" text NOT NULL, name text NOT NULL, "tokenHash" text NOT NULL, "lastUsedAt" timestamptz, "revokedAt" timestamptz)')
    await pool.query('CREATE TABLE byos_connections (id uuid PRIMARY KEY, "ownerId" text, "workspaceId" text, state text, epoch bigint, provider text); CREATE TABLE byos_bindings (id uuid PRIMARY KEY, "ownerId" text, "workspaceId" text, "consumerId" text, "connectionId" uuid, "connectionRevision" bigint, route text, "modelId" text, "createdAt" timestamptz NOT NULL DEFAULT now()); CREATE TABLE byos_native_runs ("runId" uuid PRIMARY KEY REFERENCES agent_runs(id), "bindingId" uuid NOT NULL REFERENCES byos_bindings(id)); CREATE TABLE agents (id uuid PRIMARY KEY, "userId" text NOT NULL, "deviceId" uuid, harness text, name text NOT NULL, instructions text NOT NULL DEFAULT \'\'); CREATE UNIQUE INDEX agent_name_test ON agents ("userId",lower(name)); CREATE TABLE device_repos (id uuid PRIMARY KEY, "userId" text NOT NULL, "deviceId" uuid, "repoPath" text NOT NULL, "baseBranch" text, UNIQUE ("deviceId","repoPath"))')
    await pool.query(await readFile(new URL('../../drizzle/20261027164502_computer_run_bindings.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027164510_local_computer_reviews.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027164511_cloud_device_scope.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027164512_cloud_worker_leases.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027164513_computer_run_approvals.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027164514_bot_cloud_runtimes.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027164515_workspace_computer_policy.sql', import.meta.url), 'utf8'))
    const actor = { userId: 'synthetic-owner', workspaceId: randomUUID() }
    const store = new ComputerStore(pool)
    const bot = await store.createBot(actor, 'Synthetic Bot')
    stage = 'provision'
    await store.operate(actor, bot.id, 'wake')
    stage = 'connect'
    const id = (await pool.query('SELECT "sandboxId" FROM cloud_machines')).rows[0].sandboxId as string
    sandbox = await Sandbox.connect(id, connection)
    stage = 'start mock service'
    await sandbox.files.write('/tmp/mikka-mock-device-server.py', await readFile(new URL('./mock-device-server.py', import.meta.url), 'utf8'), { user: 'user' })
    await sandbox.commands.run(`MIKKA_TEST_WORKSPACE=${actor.workspaceId} /usr/bin/python3 /tmp/mikka-mock-device-server.py > /tmp/mikka-mock-server.log 2>&1`, { user: 'user', background: true, timeoutMs: 0 })
    stage = 'check mock service'
    await sandbox.commands.run('for i in $(seq 1 30); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8765/ | grep -q 401 && exit 0; sleep .2; done; exit 1', { user: 'user', timeoutMs: 10_000 })
    let done = false
    let observedDevice: string | undefined
    let renewed = false
    const replacement = `orv_${randomBytes(32).toString('base64url')}`
    const expectedHash = createHash('sha256').update(replacement).digest('hex')
    const approved = new Set<string>(), operations: string[] = []
    const active = sandbox
    const observe = (async () => {
      while (!done) {
        const marker = await active.files.read('/tmp/mikka-worker-registration.json', { user: 'root' }).catch(() => null)
        if (marker) {
          const item = JSON.parse(marker) as { deviceId: string; hash: string; harnesses: unknown[] }
          const verified = await pool.query('UPDATE device_tokens SET "lastUsedAt"=now() WHERE "tokenHash"=$1 AND "userId"=$2 AND "boundDeviceId"=$3 AND "boundWorkspaceId"=$4 AND "revokedAt" IS NULL RETURNING id', [item.hash, actor.userId, item.deviceId, actor.workspaceId])
          if (verified.rowCount) await pool.query('UPDATE devices SET "lastSeenAt"=now(),harnesses=$3 WHERE id=$1 AND "ownerId"=$2', [item.deviceId, actor.userId, JSON.stringify(item.harnesses)])
        }
        if (observedDevice) {
          const review = await active.files.read('/tmp/mikka-worker-review.json', { user: 'root' }).catch(() => null)
          if (review) {
            const snapshots = computerSyncBody.parse({ requests: JSON.parse(review) }).requests
            let existing = await syncComputerReviews(pool, observedDevice, actor.userId, snapshots)
            if (snapshots.length && !renewed) {
              // Switch credentials while a real task is waiting for approval.
              await active.files.write('/tmp/mikka-worker-renewal.next', JSON.stringify({ credential: replacement }), { user: 'user' })
              await active.commands.run('mv /tmp/mikka-worker-renewal.next /tmp/mikka-worker-renewal.json', { user: 'user' })
              const deadline = Date.now() + 50_000
              while (Date.now() < deadline && !renewed) {
                const current = await active.files.read('/tmp/mikka-worker-registration.json', { user: 'root' }).catch(() => null)
                renewed = Boolean(current && JSON.parse(current).hash === expectedHash)
                if (!renewed) await new Promise(resolve => setTimeout(resolve, 500))
              }
              assert.ok(renewed, 'worker re-registers with the replacement while the task is active')
              existing = await syncComputerReviews(pool, observedDevice, actor.userId, snapshots)
            }
            for (const request of snapshots) if (!approved.has(request.id)) {
              if (approved.size === 0) assert.equal(await decideComputerReview(pool, actor, request.id, request.digest, true, 'run'), true)
              else assert.ok(existing.some(decision => decision.id === request.id && decision.digest === request.digest && decision.approve), 'later operation receives this run’s approval')
              approved.add(request.id); operations.push(request.call.name)
            }
            const decisions = await syncComputerReviews(pool, observedDevice, actor.userId, snapshots)
            await active.files.write('/tmp/mikka-worker-decisions.next', JSON.stringify(decisions), { user: 'user' })
            await active.commands.run('mv /tmp/mikka-worker-decisions.next /tmp/mikka-worker-decisions.json', { user: 'user' })
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    })()
    try {
      const server = `https://${sandbox.getHost(8765)}/mikka`
      stage = 'start cloud worker'
      const worker = await startCloudWorker(pool, actor, sandbox, server, process.env.E2B_WORKER_SHA!)
      observedDevice = worker.deviceId
      stage = 'reuse cloud worker'
      const again = await startCloudWorker(pool, actor, sandbox, server, process.env.E2B_WORKER_SHA!)
      assert.equal(again.deviceId, worker.deviceId)
      assert.equal(Number((await pool.query('SELECT count(*) FROM device_tokens WHERE "boundDeviceId"=$1', [worker.deviceId])).rows[0].count), 1)
      await sandbox.commands.run('if test -r /home/mikka-runner/.mikka/worker/device.json; then exit 1; fi', { user: 'user' })
      stage = 'provision Bot working tree'
      const runtimes = await ensureBotRuntime(pool, actor, bot.id, sandbox, worker.deviceId)
      const codex = runtimes.find(item => item.harness === 'codex')
      assert.ok(codex)
      assert.deepEqual(await ensureBotRuntime(pool, actor, bot.id, sandbox, worker.deviceId), runtimes)
      stage = 'install guarded driver probe'
      await sandbox.files.write('/home/mikka-runner/.mikka/driver-probe.mjs', await readFile(new URL('../../packages/daemon/src/computer/driver.mjs', import.meta.url), 'utf8'), { user: 'mikka-runner' })
      await sandbox.files.write('/home/mikka-runner/.mikka/guard-probe.mjs', `import {detectComputerDriver,executeDriver} from './driver-probe.mjs';\nconst d=await detectComputerDriver('/opt/mikka/computer/cua-driver');\nif(!d)throw new Error('driver unavailable');\nawait executeDriver(d,{name:'click',arguments:{x:500,y:500}},':1',{botId:${JSON.stringify(bot.id)},ownerId:${JSON.stringify(actor.userId)},policyVersion:Number(process.argv[2])});\n`, { user: 'mikka-runner' })
      const probe = (version = 0) => sandbox!.commands.run(`node /home/mikka-runner/.mikka/guard-probe.mjs ${version}`, { user: 'mikka-runner', timeoutMs: 30_000 })
      stage = 'deny agent while person controls'
      await store.operate(actor, bot.id, 'takeover')
      const before = await sandbox.commands.run('DISPLAY=:1 xdotool getmouselocation --shell', { user: 'mikka-runner' })
      await assert.rejects(probe())
      const after = await sandbox.commands.run('DISPLAY=:1 xdotool getmouselocation --shell', { user: 'mikka-runner' })
      assert.equal(after.stdout, before.stdout)
      await store.operate(actor, bot.id, 'handback')
      stage = 'deny another Bot and task user'
      await sandbox.files.write('/home/mikka-runner/.mikka/wrong-bot-probe.mjs', `import {detectComputerDriver,executeDriver} from './driver-probe.mjs';\nconst d=await detectComputerDriver('/opt/mikka/computer/cua-driver');\nif(!d)throw new Error('driver unavailable');\nawait executeDriver(d,{name:'click',arguments:{x:500,y:500}},':1',{botId:${JSON.stringify(randomUUID())},ownerId:${JSON.stringify(actor.userId)},policyVersion:0});\n`, { user: 'mikka-runner' })
      await assert.rejects(sandbox.commands.run('node /home/mikka-runner/.mikka/wrong-bot-probe.mjs', { user: 'mikka-runner', timeoutMs: 30_000 }))
      await sandbox.commands.run('if test -r /run/mikka-viewer/1.json || test -w /run/mikka-viewer/1.lock; then exit 1; fi', { user: 'user' })
      stage = 'allow agent after handback'
      await probe()
      stage = 'workspace denial is enforced at the real driver'
      await sandbox.commands.run("flock -F -s /run/mikka-viewer/1.lock sh -c 'touch /home/mikka-runner/.mikka/policy-lock-held; exec sleep 2'", { user: 'mikka-runner', background: true, timeoutMs: 0 })
      await sandbox.commands.run('for i in $(seq 1 50); do test -f /home/mikka-runner/.mikka/policy-lock-held && exit 0; sleep .1; done; exit 1', { user: 'mikka-runner', timeoutMs: 7_000 })
      const policyBegan = Date.now()
      await store.setPolicy(actor.workspaceId, 'deny')
      assert.ok(Date.now() - policyBegan >= 800, 'workspace denial waits for an operation already in progress')
      await assert.rejects(probe())
      await store.operate(actor, bot.id, 'wake')
      await assert.rejects(probe(), 'waking must not bypass the workspace denial')
      await store.setPolicy(actor.workspaceId, 'ask')
      await assert.rejects(probe(), 'a stale run stays blocked after re-enablement')
      await probe(2)
      stage = 'serialize takeover with an active operation'
      await sandbox.commands.run("flock -F -s /run/mikka-viewer/1.lock sh -c 'touch /home/mikka-runner/.mikka/lock-held; exec sleep 2'", { user: 'mikka-runner', background: true, timeoutMs: 0 })
      await sandbox.commands.run('for i in $(seq 1 50); do test -f /home/mikka-runner/.mikka/lock-held && exit 0; sleep .1; done; exit 1', { user: 'mikka-runner', timeoutMs: 7_000 })
      const began = Date.now()
      await store.operate(actor, bot.id, 'takeover')
      assert.ok(Date.now() - began >= 800, 'takeover waits for the operation lock')
      await store.operate(actor, bot.id, 'handback')
      stage = 'prepare synthetic Bot task'
      const agentId = codex.agentId, repoId = codex.repoId, issueId = randomUUID(), connectionId = randomUUID()
      await pool.query('INSERT INTO byos_connections (id,"ownerId","workspaceId",state,epoch,provider) VALUES ($1,$2,$3,$4,$5,$6)', [connectionId, actor.userId, actor.workspaceId, 'connected', 1, 'codex'])
      const bindingInput = { botId: bot.id, connectionId, revision: 1, harness: 'codex' as const, modelId: 'fixture-model', idempotencyKey: 'synthetic-bind' }
      const { bindingId } = await bindBotSubscription(pool, actor, bindingInput)
      assert.equal((await bindBotSubscription(pool, actor, bindingInput)).bindingId, bindingId)
      const { runId } = await queueCloudRun(pool, actor, { botId: bot.id, issueId, agentId, deviceRepoId: repoId, title: 'FULL_COMPUTER', body: '' })
      const prompt = (await pool.query('SELECT prompt FROM agent_runs WHERE id=$1', [runId])).rows[0].prompt as string
      const leaseExpiresAt = new Date(Date.now() + 180_000).toISOString()
      const computer = await claimCloudRun(pool, actor, runId, worker.deviceId, new Date(leaseExpiresAt), bindingId)
      assert.ok(computer)
      await sandbox.files.write('/tmp/mikka-fake-codex.mjs', await readFile(new URL('../../packages/daemon/test/fakes/fake-codex-subscription.mjs', import.meta.url), 'utf8'), { user: 'root' })
      await sandbox.commands.run('install -m 0755 /tmp/mikka-fake-codex.mjs /usr/local/bin/codex', { user: 'root' })
      await sandbox.commands.run('DISPLAY=:1 stdbuf -oL xev -name MikkaComputerProbe -geometry 640x480+40+40 -event keyboard -event mouse > /tmp/mikka-xev.log 2>&1', { user: 'user', background: true, timeoutMs: 0 })
      await sandbox.commands.run('for i in $(seq 1 50); do id=$(DISPLAY=:1 xdotool search --onlyvisible --name MikkaComputerProbe 2>/dev/null | head -1); if test -n "$id"; then DISPLAY=:1 xdotool windowmove "$id" 40 40 windowsize "$id" 640 480 windowactivate --sync "$id"; exit 0; fi; sleep .1; done; exit 1', { user: 'user', timeoutMs: 10_000 })
      const repoPath = `/home/mikka-runner/.mikka/bot-workspaces/${bot.id}`
      const assignment = { runId, issueId, deviceId: worker.deviceId, repoId, baseBranch: 'main', harness: 'codex', prompt, model: 'fixture-model', verifyCommand: 'true', leaseExpiresAt, computer,
        subscriptionBinding: { bindingId, ownerId: actor.userId, workspaceId: actor.workspaceId, consumerId: agentId, route: 'codex_cli' } }
      const context = { route: 'codex_cli', modelId: 'fixture-model', revision: 2, accountId: 'fixture-account', expiresAt: new Date(Date.now() + 180_000).toISOString() }
      await sandbox.files.write('/tmp/mikka-worker-run.next', JSON.stringify({ runId, repoId, repoPath, leaseExpiresAt, assignment, context }), { user: 'user' })
      await sandbox.commands.run('mv /tmp/mikka-worker-run.next /tmp/mikka-worker-run.json', { user: 'user' })
      stage = 'wait for synthetic Bot task'
      const deadline = Date.now() + 120_000
      let completion: { stopReason?: string } | undefined
      while (Date.now() < deadline && !completion) {
        const raw = await sandbox.files.read('/tmp/mikka-worker-completion.json', { user: 'root' }).catch(() => null)
        if (raw) completion = JSON.parse(raw)
        else await new Promise(resolve => setTimeout(resolve, 500))
      }
      assert.equal(completion?.stopReason, 'submitted')
      assert.ok(renewed)
      assert.deepEqual(operations, ['get_desktop_state', 'click', 'press_key', 'scroll'])
      const desktopEvents = await sandbox.files.read('/tmp/mikka-xev.log', { user: 'root' })
      assert.match(desktopEvents, /keysym[^\n]*Tab/, 'the approved key reached the desktop window')
      assert.match(desktopEvents, /button 5/, 'the approved scroll reached the desktop window')
      const event = JSON.parse(await sandbox.files.read('/tmp/mikka-worker-computer-event.json', { user: 'root' }))
      assert.deepEqual(event, { type: 'data-computer', data: { botId: bot.id, runId, task: 'FULL_COMPUTER', state: 'working' } })
      console.log(JSON.stringify({ syntheticRegistration: true, workerReused: true, credentialPrivate: true, credentialRenewed: true, pinnedSource: true, otherBotDenied: true, taskLeasePrivate: true, workspacePolicyDeniesDriver: true, workspacePolicyWaitsForOperation: true, takeoverDeniesAgent: true, handbackAllowsAgent: true, takeoverWaitsForOperation: true, syntheticBotTaskSubmitted: true, screenshotClickKeyScrollApproved: true, keyboardAndScrollReachedWindow: true, computerEventMatchesBot: true }))
    } finally { done = true; await observe }
  } catch (error) {
    if (sandbox && stage === 'check mock service') {
      const log = await sandbox.files.read('/tmp/mikka-mock-server.log', { user: 'root' }).catch(() => '')
      if (log.includes('ModuleNotFoundError')) console.error('mock service Python dependency unavailable')
      else if (log.includes('PermissionError')) console.error('mock service permission denied')
      else if (log.includes('Address already in use')) console.error('mock service port unavailable')
    }
    if (sandbox && stage === 'start cloud worker') {
      const log = await sandbox.files.read('/home/mikka-runner/.mikka/worker-bootstrap.log', { user: 'root' }).catch(() => '')
      if (log.includes('Cloud worker unavailable')) console.error('cloud worker bootstrap failed')
    }
    throw error
  } finally {
    const ids = await pool.query('SELECT "sandboxId" FROM cloud_machines WHERE "sandboxId" IS NOT NULL').catch(() => ({ rows: [] }))
    for (const { sandboxId } of ids.rows) await Sandbox.kill(sandboxId, connection)
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
}
void main().catch(error => { console.error(`stage=${stage}`, error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : 'Worker acceptance failed'); process.exitCode = 1 })
