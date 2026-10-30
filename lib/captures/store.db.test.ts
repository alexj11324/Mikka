import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// Run captures belong to one run and its owner: teammates, other devices and
// other workspaces never read, share or make them. Uploads count only once
// the bytes match what was announced; cloud recordings never outlive their
// run. Database regressions execute only in CI against ephemeral Postgres 17.
// Local pure runs skip them; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
    && ['postgres:', 'postgresql:'].includes(target.protocol)
    && target.hostname === '127.0.0.1' && target.port === '5432' && target.pathname === '/mikka_e2e'
    && !target.search && !target.hash && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable CI database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from('IHDR-test-image')])
const MP4 = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from('ftypisom-test-video')])
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

dbTest('captures stay with their run\'s owner, uploads are checked, and recordings end with their run', async t => {
  const [{ createRequestDatabaseScope, pool }, store, { ScreenCaptures }, { artifactStorage }] = await Promise.all([
    import('../db'), import('./store'), import('./screen'), import('../artifacts/storage'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const alice = `test-captures-alice-${randomUUID()}`
  const bob = `test-captures-bob-${randomUUID()}`
  const workspaceId = randomUUID(), botId = randomUUID(), agentId = randomUUID(), bobAgentId = randomUUID()
  const cloudDevice = randomUUID(), localDevice = randomUUID(), bobDevice = randomUUID(), cloudToken = randomUUID()
  const threadDevice = randomUUID(), threadToken = randomUUID(), threadRun = randomUUID()
  const cloudRun = randomUUID(), localRun = randomUUID(), bobRun = randomUUID(), artifactId = randomUUID()
  const runs = [cloudRun, localRun, bobRun, threadRun]
  t.after(async () => {
    await scope.run(async () => {
      await pool.query('DELETE FROM artifacts WHERE id=$1', [artifactId])
      await pool.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [runs])
      await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])
      await pool.query('DELETE FROM cloud_machines WHERE "workspaceId"=$1', [workspaceId])
      await pool.query('DELETE FROM bots WHERE id=$1', [botId])
      await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [[agentId, bobAgentId]])
      await pool.query('DELETE FROM devices WHERE id=ANY($1::uuid[])', [[cloudDevice, localDevice, bobDevice, threadDevice]])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[alice, bob]])
    })
    await scope.close()
  })

  await scope.run(async () => {
    assert.equal(artifactStorage(), 'inline', 'the test database keeps files in rows, never in a bucket')
    // The E2E schema comes from the Drizzle tables; the migration adds its
    // indexes and constraints, and must be safe to run again over them.
    const migration = await readFile(new URL('../../drizzle/20261029043636_run_captures.sql', import.meta.url), 'utf8')
    await pool.query(migration); await pool.query(migration)
    for (const id of [alice, bob]) await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1,$1,$2,false,now(),now())`, [id, `${id}@example.com`])
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'cloud','cloud'),($3,$2,'mac','local'),($4,$5,'bob','local')`, [cloudDevice, alice, localDevice, bobDevice, bob])
    await pool.query(`INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES ($1,$2,'synthetic',$3,$4,$5,now()+interval '5 minutes')`, [cloudToken, alice, `test-${cloudToken}`, cloudDevice, workspaceId])
    await pool.query(`INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,'codex',$3,$4),($5,$6,'codex',$7,$8)`, [agentId, alice, `Codex ${agentId}`, cloudDevice, bobAgentId, bob, `Codex ${bobAgentId}`, bobDevice])
    await pool.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,$4)`, [botId, workspaceId, alice, `Captures ${botId}`])
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","sandboxId","operationId","runtimeReady",state,"deviceId") VALUES ($1,$2,$3,$4,true,'running',$5)`, [workspaceId, alice, `sandbox-${workspaceId}`, randomUUID(), cloudDevice])
    await pool.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display,control) VALUES ($1,$2,$3,3,'agent')`, [botId, workspaceId, alice])
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","botId","deviceId",status) VALUES ($1,$2,$3,$4,$5,'running'),($6,$2,$3,null,$7,'running'),($8,$9,$10,null,$11,'running')`,
      [cloudRun, alice, agentId, botId, cloudDevice, localRun, localDevice, bobRun, bob, bobAgentId, bobDevice])
    await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [cloudRun])
    await pool.query(`INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)`, [cloudRun, botId, workspaceId, alice])
    await pool.query(`INSERT INTO artifacts (id,"userId",kind,title,"runId") VALUES ($1,$2,'markdown','Acceptance notes',$3)`, [artifactId, alice, cloudRun])

    const local = { userId: alice, runId: localRun, issueId: null, botId: null }

    // Saved captures: the owner reads them with the run's documents; nobody else does.
    const saved = await store.saveCapture(local, { bytes: PNG, title: '  Sign-in   page ', source: 'local' })
    assert.ok(!('error' in saved))
    assert.deepEqual([saved.kind, saved.contentType, saved.title, saved.size], ['image', 'image/png', 'Sign-in page', PNG.length])
    assert.equal(('error' in await store.saveCapture(local, { bytes: new TextEncoder().encode('<!doctype html><script>'), title: 'x', source: 'local' })), true)
    const evidence = await store.runEvidence(alice, localRun)
    assert.deepEqual(evidence?.captures.map(capture => capture.id), [saved.id])
    assert.equal(await store.runEvidence(bob, localRun), null, 'another person cannot list the run')
    assert.equal(await store.readCapture(bob, saved.id), null, 'nor read its captures')
    assert.deepEqual((await store.readCapture(alice, saved.id))?.bytes, PNG)
    assert.deepEqual((await store.runEvidence(alice, cloudRun))?.artifacts.map(artifact => artifact.id), [artifactId], 'documents the run handed over are listed too')

    // Daemon uploads: announced, sent, then checked against the announcement.
    const begun = await store.beginUpload(local, { title: 'Checkout', contentType: 'image/png', size: PNG.length, sha256: sha(PNG) })
    assert.ok(!('error' in begun))
    assert.deepEqual(begun.upload, { target: 'server' })
    assert.equal(('error' in await store.receiveUpload(local, begun.captureId, PNG.slice(1))), true, 'a short file is refused')
    assert.equal(('error' in await store.receiveUpload({ ...local, runId: bobRun, userId: bob }, begun.captureId, PNG)), true, 'another run cannot send it')
    assert.ok('error' in await store.resumeUpload({ ...local, runId: bobRun, userId: bob }, begun.captureId), 'another owner cannot resume it')
    assert.deepEqual(await store.resumeUpload(local, begun.captureId), begun)
    assert.deepEqual(await store.receiveUpload(local, begun.captureId, PNG), { ok: true })
    const completed = await store.completeUpload(local, begun.captureId)
    assert.ok(!('error' in completed))
    assert.equal(completed.title, 'Checkout')
    assert.deepEqual(await store.completeUpload(local, begun.captureId), completed, 'a lost completion response is safe to retry')
    assert.ok('error' in await store.resumeUpload(local, begun.captureId), 'a completed reservation cannot be reused')
    const simultaneous = await store.beginUpload(local, { title: 'Two completions', contentType: 'image/png', size: PNG.length, sha256: sha(PNG) })
    assert.ok(!('error' in simultaneous))
    await store.receiveUpload(local, simultaneous.captureId, PNG)
    const completions = await Promise.all([store.completeUpload(local, simultaneous.captureId), store.completeUpload(local, simultaneous.captureId)])
    assert.ok(completions.every(result => !('error' in result)), 'simultaneous completion requests observe the same result')
    await pool.query('DELETE FROM run_captures WHERE id=$1', [simultaneous.captureId])

    // Exercise the actual device routes after the run ends, including token revocation.
    const { hashDeviceToken } = await import('../device-link')
    const { POST: beginRoute } = await import('../../app/v1/runs/[runId]/captures/route')
    const { POST: resumeRoute, PUT: uploadRoute } = await import('../../app/v1/runs/[runId]/captures/[captureId]/route')
    const { POST: completeRoute } = await import('../../app/v1/runs/[runId]/captures/[captureId]/complete/route')
    const token = `fixture-${randomUUID()}`, tokenId = randomUUID()
    await pool.query('INSERT INTO device_tokens (id,"userId",name,"tokenHash") VALUES ($1,$2,$3,$4)', [tokenId, alice, 'test', hashDeviceToken(token)])
    try {
      const pending = await store.beginUpload(local, { title: 'After end', contentType: 'image/png', size: PNG.length, sha256: sha(PNG) })
      assert.ok(!('error' in pending))
      const url = `http://localhost/v1/runs/${localRun}/captures/${pending.captureId}`
      const params = Promise.resolve({ runId: localRun, captureId: pending.captureId })
      const headers = { authorization: `Bearer ${token}` }
      const ending = await pool.connect()
      await ending.query('BEGIN')
      await ending.query("UPDATE agent_runs SET status='succeeded', \"finishedAt\"=now() WHERE id=$1", [localRun])
      const racingBegin = store.beginUpload(local, { title: 'Too late', contentType: 'image/png', size: PNG.length, sha256: sha(PNG) })
      await ending.query('COMMIT')
      ending.release()
      assert.ok('error' in await racingBegin, 'a reservation racing run termination cannot start after it ends')
      assert.equal((await beginRoute(new Request(url, { method: 'POST', headers }), { params: Promise.resolve({ runId: localRun }) })).status, 404, 'ending a run forbids new reservations')
      assert.equal((await resumeRoute(new Request(url, { method: 'POST', headers }), { params })).status, 200)
      assert.equal((await uploadRoute(new Request(url, { method: 'PUT', headers, body: PNG }), { params })).status, 204)
      assert.equal((await completeRoute(new Request(`${url}/complete`, { method: 'POST', headers }), { params })).status, 200)
      assert.equal((await completeRoute(new Request(`${url}/complete`, { method: 'POST', headers }), { params })).status, 200, 'completion is idempotent')
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [localRun])
      assert.equal((await completeRoute(new Request(`${url}/complete`, { method: 'POST', headers }), { params })).status, 404, 'a stopped run does not regain capture authority')
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=null WHERE id=$1', [localRun])
      await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
      assert.equal((await completeRoute(new Request(`${url}/complete`, { method: 'POST', headers }), { params })).status, 401, 'revoked credentials stay revoked')
      await pool.query('DELETE FROM run_captures WHERE id=$1', [pending.captureId])
    } finally {
      await pool.query('DELETE FROM device_tokens WHERE id=$1', [tokenId])
      await pool.query("UPDATE agent_runs SET status='running', \"finishedAt\"=null WHERE id=$1", [localRun])
    }

    const swapped = new Uint8Array(PNG); swapped[PNG.length - 1] ^= 1
    assert.ok('error' in await store.receiveUpload(local, begun.captureId, swapped), 'a completed upload cannot be overwritten')
    assert.deepEqual((await store.readCapture(alice, begun.captureId))?.bytes, PNG)
    for (let attempt = 0; attempt < 10; attempt++) {
      const racing = await store.beginUpload(local, { title: 'Race', contentType: 'image/png', size: PNG.length, sha256: sha(PNG) })
      assert.ok(!('error' in racing))
      await store.receiveUpload(local, racing.captureId, PNG)
      await Promise.all([store.completeUpload(local, racing.captureId), store.receiveUpload(local, racing.captureId, swapped)])
      const visible = await store.readCapture(alice, racing.captureId)
      if (visible) assert.deepEqual(visible.bytes, PNG, 'a racing PUT cannot change verified bytes')
      await pool.query('DELETE FROM run_captures WHERE id=$1', [racing.captureId])
    }

    // Simulate an R2 client entirely in memory. A presigned PUT is reusable:
    // rewriting its staging key after completion must not change the evidence.
    const originalFetch = globalThis.fetch
    const names = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ARTIFACTS_BUCKET'] as const
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
    const objects = new Map<string, Uint8Array>()
    try {
      Object.assign(process.env, { R2_ACCOUNT_ID: 'synthetic', R2_ACCESS_KEY_ID: 'synthetic', R2_SECRET_ACCESS_KEY: 'synthetic', R2_ARTIFACTS_BUCKET: 'test' })
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        assert.equal(url.hostname, 'synthetic.r2.cloudflarestorage.com')
        const key = url.pathname
        if (request.method === 'PUT') {
          if (request.headers.get('if-none-match') === '*' && objects.has(key)) return new Response(null, { status: 412 })
          objects.set(key, new Uint8Array(await request.arrayBuffer()))
          return new Response(null, { status: 200 })
        }
        if (request.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }) }
        const bytes = objects.get(key)
        return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 })
      }
      const r2 = await store.beginUpload(local, { title: 'R2', contentType: 'image/png', size: PNG.length, sha256: sha(PNG) })
      assert.ok(!('error' in r2) && r2.upload.target === 'storage')
      await fetch(r2.upload.url, { method: 'PUT', headers: r2.upload.headers, body: PNG })
      const verified = await store.completeUpload(local, r2.captureId)
      assert.ok(!('error' in verified))
      await fetch(r2.upload.url, { method: 'PUT', headers: r2.upload.headers, body: swapped })
      assert.deepEqual((await store.readCapture(alice, r2.captureId))?.bytes, PNG, 'replayed signed PUT cannot replace verified evidence')
    } finally {
      globalThis.fetch = originalFetch
      for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]
    }
    const tampered = await store.beginUpload(local, { title: 'Tampered', contentType: 'image/png', size: PNG.length, sha256: sha(PNG) })
    assert.ok(!('error' in tampered))
    await store.receiveUpload(local, tampered.captureId, swapped)
    assert.match((await store.completeUpload(local, tampered.captureId) as { message: string }).message, /sha256/)
    const disguised = await store.beginUpload(local, { title: 'Disguised', contentType: 'video/mp4', size: PNG.length, sha256: sha(PNG) })
    assert.ok(!('error' in disguised))
    await store.receiveUpload(local, disguised.captureId, PNG)
    assert.match((await store.completeUpload(local, disguised.captureId) as { message: string }).message, /not video\/mp4/)
    assert.equal((await store.beginUpload(local, { title: 'Huge', contentType: 'video/mp4', size: store.INLINE_UPLOAD_MAX_BYTES + 1, sha256: sha(MP4) }) as { error: string }).error, 'too_large')
    const stale = await store.beginUpload(local, { title: 'Stale', contentType: 'image/png', size: PNG.length, sha256: sha(PNG) })
    assert.ok(!('error' in stale))
    await pool.query(`UPDATE run_captures SET "expiresAt"=now()-interval '1 minute' WHERE id=$1`, [stale.captureId])
    assert.equal(('error' in await store.completeUpload(local, stale.captureId)), true, 'an expired upload never completes')
    await store.beginUpload(local, { title: 'Next', contentType: 'image/png', size: PNG.length, sha256: sha(PNG) })
    assert.equal((await pool.query('SELECT status FROM run_captures WHERE id=$1', [stale.captureId])).rows[0].status, 'failed')
    assert.deepEqual((await store.runEvidence(alice, localRun))?.captures.map(capture => capture.title), ['Sign-in page', 'Checkout', 'R2'], 'only checked files are listed')

    // Share links work as artifact links: the owner makes and ends them.
    assert.equal(await store.createCaptureShare(bob, saved.id), null)
    const share = await store.createCaptureShare(alice, saved.id)
    assert.ok(share?.token.startsWith('mkc_'))
    assert.deepEqual((await store.sharedCapture(share!.token))?.bytes, PNG)
    assert.equal(await store.revokeCaptureShares(bob, saved.id), 0)
    assert.equal(await store.revokeCaptureShares(alice, saved.id), 1)
    assert.equal(await store.sharedCapture(share!.token), null)
    assert.equal(await store.sharedCapture(`mks_${share!.token.slice(4)}`), null)

    // Cloud computer: the run's own desktop, through a fake E2B runtime.
    const calls: string[] = []
    let failStart = false, gone = false
    const runtime = {
      async connectComputer(_workspaceId: string, id: string) { if (gone) throw new Error('https://api.e2b.invalid/secret'); calls.push(`connect ${id}`); return { sandboxId: id } },
      async captureScreenshot(_sandbox: unknown, display: number) { calls.push(`shot :${display}`); return PNG },
      async startScreenRecording(_sandbox: unknown, display: number, id: string, seconds: number) { if (failStart) throw new Error('ffmpeg missing'); calls.push(`record :${display} ${id} ${seconds}`) },
      async stopScreenRecording(_sandbox: unknown, display: number, id: string) { calls.push(`stop :${display} ${id}`); return { bytes: MP4, durationMs: 4200 } },
      async discardScreenRecording(_sandbox: unknown, display: number, id: string) { calls.push(`discard :${display} ${id}`) },
    } as unknown as ConstructorParameters<typeof ScreenCaptures>[0]
    const screen = new ScreenCaptures(runtime)
    const worker = { userId: alice, workspaceId, deviceId: cloudDevice, tokenId: cloudToken }

    const shot = await screen.screenshot(worker, cloudRun, 'Dashboard')
    assert.ok(!('error' in shot))
    assert.equal(shot.source, 'cloud_computer')
    assert.deepEqual(calls, [`connect sandbox-${workspaceId}`, 'shot :3'])
    assert.equal((await pool.query('SELECT "botId" FROM run_captures WHERE id=$1', [shot.id])).rows[0].botId, botId)
    // A revoke that wins the common policy lock must be observed before capture.
    const revoker = await pool.connect()
    await revoker.query('BEGIN')
    await revoker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${workspaceId}`])
    await revoker.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version) VALUES ($1,'deny',1)` , [workspaceId])
    const beforeRevokeCalls = calls.length
    const racingShot = screen.screenshot(worker, cloudRun, 'Racing revoke')
    const racingStart = screen.startRecording(worker, cloudRun, 'Racing revoke', 5)
    await new Promise(resolve => setTimeout(resolve, 50))
    const duringRevokeCalls = calls.length
    await revoker.query('COMMIT')
    revoker.release()
    assert.equal(duringRevokeCalls, beforeRevokeCalls, 'capture waits while the revocation owns the policy lock')
    assert.equal((await racingShot as { error: string }).error, 'unavailable')
    assert.equal((await racingStart as { error: string }).error, 'unavailable')
    assert.equal(calls.length, beforeRevokeCalls, 'a denied capture never reaches the runtime')
    await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])
    await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`, [cloudRun])
    assert.equal((await screen.screenshot(worker, cloudRun, 'Expired') as { error: string }).error, 'not_found')
    assert.equal(calls.length, beforeRevokeCalls, 'an expired lease never reaches the runtime')
    await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [cloudRun])
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [cloudDevice])
    assert.equal((await screen.screenshot(worker, cloudRun, 'Disabled device') as { error: string }).error, 'not_found')
    await pool.query('UPDATE devices SET enabled=true WHERE id=$1', [cloudDevice])
    await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [cloudToken])
    assert.equal((await screen.screenshot(worker, cloudRun, 'Revoked token') as { error: string }).error, 'not_found')
    await pool.query('UPDATE device_tokens SET "revokedAt"=null WHERE id=$1', [cloudToken])
    const alreadyCancelled = new AbortController(); alreadyCancelled.abort()
    assert.ok('error' in await screen.screenshot(worker, cloudRun, 'Cancelled', alreadyCancelled.signal))
    assert.equal(calls.length, beforeRevokeCalls, 'disabled or cancelled work never reaches the runtime')
    let releaseCapture!: () => void, enteredCapture!: () => void
    const entered = new Promise<void>(resolve => { enteredCapture = resolve })
    const release = new Promise<void>(resolve => { releaseCapture = resolve })
    const fenced = new ScreenCaptures({ ...runtime, async connectComputer() { enteredCapture(); await release; return {} } } as unknown as ConstructorParameters<typeof ScreenCaptures>[0])
    const inFlight = fenced.screenshot(worker, cloudRun, 'Before revoke')
    await entered
    let revokeAcquired = false
    const revokeAfter = (async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${workspaceId}`])
        revokeAcquired = true
        await client.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version) VALUES ($1,'deny',1)`, [workspaceId])
        await client.query('COMMIT')
      } finally { client.release() }
    })()
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(revokeAcquired, false, 'revocation waits for the in-flight capture')
    } finally { releaseCapture() }
    const beforeRevoke = await inFlight
    assert.ok(!('error' in beforeRevoke))
    await revokeAfter
    assert.equal((await screen.screenshot(worker, cloudRun, 'After revoke') as { error: string }).error, 'unavailable')
    await pool.query('DELETE FROM run_captures WHERE id=$1', [beforeRevoke.id])
    await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])

    // An actual synthetic subprocess stands in for a hung provider call.
    // STOP waits for at most the bounded window, then the signal kills the
    // subprocess and the database lock is released. No screen is captured.
    let captureEntered!: () => void
    const captureReady = new Promise<void>(resolve => { captureEntered = resolve })
    let processExited!: () => void
    const exited = new Promise<void>(resolve => { processExited = resolve })
    const hanging = new ScreenCaptures({ ...runtime,
      async captureScreenshot(_sandbox: unknown, _display: number, _id: string, signal: AbortSignal) {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        child.once('exit', processExited)
        signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
        captureEntered()
        return new Promise<Uint8Array>((_resolve, reject) => child.once('exit', () => reject(new Error('cancelled'))))
      },
    } as unknown as ConstructorParameters<typeof ScreenCaptures>[0], Date.now, 200)
    const waitingCapture = hanging.screenshot(worker, cloudRun, 'Hung synthetic operation')
    await captureReady
    let stopFinished = false
    const stop = pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [cloudRun]).then(() => { stopFinished = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(stopFinished, false, 'STOP serializes behind an in-flight request')
    const timedOut = await waitingCapture
    assert.ok('error' in timedOut && /unknown/.test(timedOut.message), 'a timed out request has an uncertain outcome')
    await stop
    await exited
    assert.equal(stopFinished, true, 'STOP acquires the released lock')
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=null WHERE id=$1', [cloudRun])

    let enteredCancellation!: () => void
    const cancellationReady = new Promise<void>(resolve => { enteredCancellation = resolve })
    const cancellable = new ScreenCaptures({ ...runtime,
      async captureScreenshot(_sandbox: unknown, _display: number, _id: string, signal: AbortSignal) {
        enteredCancellation()
        return new Promise<Uint8Array>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
      },
    } as unknown as ConstructorParameters<typeof ScreenCaptures>[0], Date.now, 5000)
    const abort = new AbortController()
    const cancelled = cancellable.screenshot(worker, cloudRun, 'Cancelled synthetic request', abort.signal)
    await cancellationReady
    const cancelledAt = Date.now()
    abort.abort()
    const cancelResult = await cancelled
    assert.ok('error' in cancelResult && /unknown/.test(cancelResult.message))
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [cloudRun])
    assert.ok(Date.now() - cancelledAt < 2000, 'cancellation releases STOP without waiting for the five-second deadline')
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=null WHERE id=$1', [cloudRun])

    // A provider can ignore cancellation. Its late response is not evidence
    // and cannot delay policy revocation after the bounded window.
    let lateEntered!: () => void, resolveLate!: (bytes: Uint8Array) => void
    const lateReady = new Promise<void>(resolve => { lateEntered = resolve })
    const lateBytes = new Promise<Uint8Array>(resolve => { resolveLate = resolve })
    const ignoringAbort = new ScreenCaptures({ ...runtime, async captureScreenshot() { lateEntered(); return lateBytes } } as unknown as ConstructorParameters<typeof ScreenCaptures>[0], Date.now, 200)
    const beforeLate = (await pool.query('SELECT count(*)::int AS n FROM run_captures WHERE "runId"=$1', [cloudRun])).rows[0].n
    const lateResult = ignoringAbort.screenshot(worker, cloudRun, 'Late response')
    await lateReady
    let policyDone = false
    let tokenRevoked = false
    const revokeToken = pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [cloudToken]).then(() => { tokenRevoked = true })
    const lateRevoke = (async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${workspaceId}`])
        await client.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version) VALUES ($1,'deny',1)`, [workspaceId])
        await client.query('COMMIT')
        policyDone = true
      } finally { client.release() }
    })()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(policyDone, false)
    assert.equal(tokenRevoked, false, 'credential revocation serializes against the issued request')
    const lateOutcome = await lateResult
    assert.ok('error' in lateOutcome && /unknown/.test(lateOutcome.message))
    await lateRevoke
    await revokeToken
    resolveLate(PNG)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_captures WHERE "runId"=$1', [cloudRun])).rows[0].n, beforeLate, 'late bytes are not saved')
    await pool.query('UPDATE device_tokens SET "revokedAt"=null WHERE id=$1', [cloudToken])
    assert.equal((await screen.screenshot(worker, cloudRun, 'After timeout revoke') as { error: string }).error, 'unavailable')
    await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])

    let enteredStart!: () => void, starts = 0
    const startReady = new Promise<void>(resolve => { enteredStart = resolve })
    const uncertainStart = new ScreenCaptures({ ...runtime,
      async startScreenRecording(_sandbox: unknown, _display: number, _id: string, _seconds: number, signal: AbortSignal) {
        starts++; enteredStart()
        return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
      },
    } as unknown as ConstructorParameters<typeof ScreenCaptures>[0], Date.now, 200)
    const uncertainRecording = uncertainStart.startRecording(worker, cloudRun, 'Unknown synthetic start', 5)
    await startReady
    const stoppingStart = pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [cloudRun])
    const startOutcome = await uncertainRecording
    assert.ok('error' in startOutcome && /unknown/.test(startOutcome.message))
    await stoppingStart
    assert.equal(starts, 1, 'an uncertain start is not automatically retried')
    const unresolved = await store.currentRecording(cloudRun)
    assert.ok(unresolved, 'keep the slot because a remote start may have happened')
    await uncertainStart.stopRunRecordings([cloudRun])
    assert.equal(await store.currentRecording(cloudRun), null)
    await pool.query('DELETE FROM run_captures WHERE id=$1', [unresolved.id])
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=null WHERE id=$1', [cloudRun])
    for (const caller of [{ ...worker, deviceId: localDevice }, { ...worker, workspaceId: randomUUID() }, { ...worker, userId: bob }])
      assert.equal((await screen.screenshot(caller, cloudRun, 'x') as { error: string }).error, 'not_found')
    assert.equal((await screen.screenshot(worker, localRun, 'x') as { error: string }).error, 'not_found', 'a run with no cloud computer')

    await pool.query(`UPDATE bot_desktops SET control='user',"controlledBy"=$2,"controlUntil"=now()+interval '5 minutes' WHERE "botId"=$1`, [botId, alice])
    assert.equal((await screen.screenshot(worker, cloudRun, 'x') as { error: string }).error, 'conflict', 'not while the person holds the desktop')
    await pool.query(`UPDATE bot_desktops SET control='agent',"controlledBy"=null,"controlUntil"=null WHERE "botId"=$1`, [botId])
    await pool.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version) VALUES ($1,'deny',1)`, [workspaceId])
    assert.equal((await screen.screenshot(worker, cloudRun, 'x') as { error: string }).error, 'unavailable', 'not when the workspace turned computers off')
    await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])

    calls.length = 0
    const started = await screen.startRecording(worker, cloudRun, 'Checkout flow', 9999)
    assert.ok(!('error' in started))
    assert.ok(calls.includes(`record :3 ${started.recordingId} 300`), 'the limit is clamped')
    assert.equal((await screen.startRecording(worker, cloudRun, 'Again') as { error: string }).error, 'conflict')
    await pool.query(`UPDATE bot_desktops SET control='user',"controlledBy"=$2,"controlUntil"=now()+interval '5 minutes' WHERE "botId"=$1`, [botId, alice])
    assert.ok(await store.currentRecording(cloudRun), 'takeover does not automatically stop an existing recording')
    const stopped = await screen.stopRecording(worker, cloudRun)
    assert.ok(!('error' in stopped))
    await pool.query(`UPDATE bot_desktops SET control='agent',"controlledBy"=null,"controlUntil"=null WHERE "botId"=$1`, [botId])
    assert.deepEqual([stopped.id, stopped.kind, stopped.durationMs], [started.recordingId, 'video', 4200])
    assert.equal((await screen.stopRecording(worker, cloudRun) as { error: string }).error, 'not_found')

    failStart = true
    assert.equal((await screen.startRecording(worker, cloudRun, 'Broken') as { error: string }).error, 'unavailable')
    failStart = false
    assert.ok(await store.currentRecording(cloudRun), 'a failed start keeps its slot because the remote outcome is unknown')
    await screen.stopRunRecordings([cloudRun])
    assert.equal(await store.currentRecording(cloudRun), null)

    // A recording past its limit is kept when the next one starts.
    const late = await screen.startRecording(worker, cloudRun, 'Late')
    assert.ok(!('error' in late))
    await pool.query(`UPDATE run_captures SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [late.recordingId])
    const after = await screen.startRecording(worker, cloudRun, 'After')
    assert.ok(!('error' in after))
    assert.equal((await pool.query('SELECT status FROM run_captures WHERE id=$1', [late.recordingId])).rows[0].status, 'ready')

    // The run ends with a recording going: it is stopped and kept.
    await pool.query(`UPDATE agent_runs SET status='completed',"finishedAt"=now() WHERE id=$1`, [cloudRun])
    await screen.stopRunRecordings([cloudRun])
    assert.equal((await pool.query('SELECT status FROM run_captures WHERE id=$1', [after.recordingId])).rows[0].status, 'ready')
    assert.equal((await screen.startRecording(worker, cloudRun, 'Too late') as { error: string }).error, 'not_found', 'an ended run records nothing')

    // The machine went away mid-recording: the slot is marked failed, not left open.
    await pool.query(`UPDATE agent_runs SET status='running',"finishedAt"=null WHERE id=$1`, [cloudRun])
    const orphan = await screen.startRecording(worker, cloudRun, 'Orphan')
    assert.ok(!('error' in orphan))
    gone = true
    await screen.stopRunRecordings([cloudRun])
    assert.equal((await pool.query('SELECT status FROM run_captures WHERE id=$1', [orphan.recordingId])).rows[0].status, 'failed')
    assert.equal(await store.currentRecording(cloudRun), null)

    const listed = await store.runEvidence(alice, cloudRun)
    assert.deepEqual(listed?.captures.map(capture => capture.title), ['Dashboard', 'Checkout flow', 'Broken', 'Late', 'After'])
    assert.equal(listed?.recording, false)

    // Dedicated threads use their own device and display, independently of
    // their source Bot machine and its current takeover/availability state.
    gone = false
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'dedicated thread','cloud')`, [threadDevice, alice])
    await pool.query(`INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES ($1,$2,'synthetic thread',$3,$4,$5,now()+interval '5 minutes')`, [threadToken, alice, `test-${threadToken}`, threadDevice, workspaceId])
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","botId","deviceId",status,"leaseExpiresAt") VALUES ($1,$2,$3,$4,$5,'running',now()+interval '5 minutes')`, [threadRun, alice, agentId, botId, threadDevice])
    await pool.query(`INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)`, [threadRun, botId, workspaceId, alice])
    await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","sandboxId","snapshotId","operationId",state,"deviceId") VALUES ($1,$2,$3,$4,$5,'synthetic snapshot',$6,'running',$7)`, [threadRun, workspaceId, alice, botId, `sandbox-${threadRun}`, randomUUID(), threadDevice])
    await pool.query(`UPDATE bot_desktops SET control='user',"controlledBy"=$2,"controlUntil"=now()+interval '5 minutes' WHERE "botId"=$1`, [botId, alice])
    await pool.query(`UPDATE cloud_machines SET state='sleeping' WHERE "workspaceId"=$1`, [workspaceId])
    const threadWorker = { userId: alice, workspaceId, deviceId: threadDevice, tokenId: threadToken }
    calls.length = 0
    assert.ok(!('error' in await screen.screenshot(threadWorker, threadRun, 'Own thread desktop')))
    assert.deepEqual(calls, [`connect sandbox-${threadRun}`, 'shot :1'])
    for (const caller of [worker, { ...threadWorker, tokenId: cloudToken }, { ...threadWorker, userId: bob }, { ...threadWorker, workspaceId: randomUUID() }]) {
      assert.equal((await screen.screenshot(caller, threadRun, 'Wrong thread authority') as { error: string }).error, 'not_found')
    }
    assert.equal(calls.length, 2, 'refused callers never touch either machine')
    await pool.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version) VALUES ($1,'deny',2)`, [workspaceId])
    assert.equal((await screen.screenshot(threadWorker, threadRun, 'Denied thread') as { error: string }).error, 'unavailable')
    await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])
    const threadRecording = await screen.startRecording(threadWorker, threadRun, 'Dedicated flow', 5)
    assert.ok(!('error' in threadRecording))
    assert.ok(calls.includes(`record :1 ${threadRecording.recordingId} 5`))
    const { Sandbox } = await import('e2b')
    const { screenCaptures } = await import('./screen')
    const { threadMachineAction } = await import('../cloud-computer/thread-machines')
    const originalKill = Sandbox.kill, originalStop = screenCaptures.stopRunRecordings, originalKey = process.env.E2B_API_KEY
    try {
      process.env.E2B_API_KEY = 'synthetic-captures'
      screenCaptures.stopRunRecordings = ids => screen.stopRunRecordings(ids)
      Sandbox.kill = async (id: string) => {
        assert.equal(id, `sandbox-${threadRun}`)
        const recording = (await pool.query('SELECT status FROM run_captures WHERE id=$1', [threadRecording.recordingId])).rows[0]
        assert.equal(recording.status, 'ready', 'the actual end path saves evidence before destroying the filesystem')
        assert.ok(calls.includes(`stop :1 ${threadRecording.recordingId}`))
        calls.push(`kill ${id}`)
        return true
      }
      assert.deepEqual(await threadMachineAction(pool, { userId: alice, workspaceId }, threadRun, 'end'), { runId: threadRun, state: 'ended' })
      assert.ok(calls.includes(`kill sandbox-${threadRun}`))
      assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [threadToken])).rows[0].revokedAt)
    } finally {
      Sandbox.kill = originalKill
      screenCaptures.stopRunRecordings = originalStop
      if (originalKey === undefined) delete process.env.E2B_API_KEY
      else process.env.E2B_API_KEY = originalKey
    }
    assert.ok(calls.every(call => !call.includes(`sandbox-${workspaceId}`)), 'completion never reads the source Bot machine')
    // A missing dedicated sandbox must not reinterpret the run as a Bot run.
    await pool.query(`UPDATE agent_runs SET status='running',"stopRequestedAt"=null WHERE id=$1`, [threadRun])
    await pool.query(`UPDATE thread_machines SET state='running',"sandboxId"=null WHERE "runId"=$1`, [threadRun])
    await pool.query('UPDATE device_tokens SET "revokedAt"=null WHERE id=$1', [threadToken])
    const beforeMissing = calls.length
    assert.equal((await screen.screenshot(threadWorker, threadRun, 'Missing dedicated sandbox') as { error: string }).error, 'unavailable')
    assert.equal(calls.length, beforeMissing)
  })
})
