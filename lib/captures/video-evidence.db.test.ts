import 'next/dist/server/node-environment-baseline'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { CAPTURE_MAX_BYTES } from '@mikka/protocol/capture'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { processCaptureVideo } from '../../packages/daemon/src/agents/capture-video.mjs'

const databaseUrl = process.env.E2E_DATABASE_URL
const eligible = databaseUrl && isE2eTarget(databaseUrl) && databaseUrl === process.env.DATABASE_URL && databaseUrl === process.env.MIKKA_DATABASE_URL
if (!eligible && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching isolated loopback database')

test('PG17 + real FFmpeg: oversized video is trimmed, compressed and stored once with its remapped timeline', { skip: !eligible, timeout: 90_000 }, async t => {
  const [{ createRequestDatabaseScope, pool }, captures, { artifactStorage }] = await Promise.all([import('../db'), import('./store'), import('../artifacts/storage')])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const directory = await mkdtemp(join(tmpdir(), 'capture-evidence-db-'))
  const userId = `video-evidence-${randomUUID()}`, agentId = randomUUID(), runId = randomUUID()
  t.after(async () => {
    await scope.run(async () => {
      await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [userId])
      await pool.query('DELETE FROM agents WHERE id=$1', [agentId])
      await pool.query('DELETE FROM "user" WHERE id=$1', [userId])
    })
    await scope.close()
    await rm(directory, { recursive: true, force: true })
  })
  const input = join(directory, 'source.mp4'), output = join(directory, 'processed.mp4')
  await promisify(execFile)('ffmpeg', ['-y','-v','error','-f','lavfi','-i','color=c=red:s=160x120:r=10:d=2',
    '-f','lavfi','-i','color=c=gray:s=160x120:r=10:d=16','-f','lavfi','-i','color=c=blue:s=160x120:r=10:d=2',
    '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',input])
  // A legal free atom makes a valid, sparse >100 MB input; no forged MP4 header.
  const handle = await open(input, 'r+')
  const before = (await handle.stat()).size, atomSize = CAPTURE_MAX_BYTES.video + 1
  const header = Buffer.alloc(8); header.writeUInt32BE(atomSize, 0); header.write('free', 4)
  await handle.write(header, 0, 8, before); await handle.truncate(before + atomSize); await handle.close()
  const steps = [{ atMs: 1500, durationMs: 1000, label: 'First action', source: 'action' as const },
    { atMs: 19_500, durationMs: 1000, label: 'Final result', source: 'action' as const }]
  const processed = await processCaptureVideo(input, output, { steps })
  assert.ok(processed.processing.originalSize > CAPTURE_MAX_BYTES.video)
  assert.ok(processed.size < CAPTURE_MAX_BYTES.video)
  assert.equal(processed.processing.trimmedMs, 14_500)
  const bytes = await readFile(output)
  await scope.run(async () => {
    assert.equal(artifactStorage(), 'inline')
    await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
    await pool.query(`INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,'codex','Synthetic capture test')`, [agentId,userId])
    await pool.query(`INSERT INTO agent_runs(id,"userId","agentId",status) VALUES($1,$2,$3,'running')`, [runId,userId,agentId])
    const slot = await captures.openRecording({ userId,runId,issueId:null,botId:null }, { title:'Synthetic test recording',display:1,stopsAt:new Date(Date.now()+60_000) })
    assert.ok(slot)
    await captures.markRecordingStarted(slot.id)
    const row = await captures.currentRecording(runId); assert.ok(row)
    let remoteStops = 0
    const finalize = () => captures.withRecordingFinalization(row, async current => {
      remoteStops++
      return captures.finishRecording(current, { bytes,durationMs:processed.durationMs,steps:processed.steps })
    })
    // Distinct concurrent callers exercise the PG fence, not ScreenCaptures' Map.
    const results = await Promise.all([finalize(),finalize()])
    assert.equal(remoteStops,1)
    assert.deepEqual(results[0],results[1])
    assert.ok(!('error' in results[0]))
    const stored = await captures.readCapture(userId,slot.id); assert.ok(stored)
    assert.deepEqual(Buffer.from(stored.bytes),bytes)
    assert.equal(stored.durationMs,processed.durationMs)
    const timeline = await captures.recordingSteps(slot.id)
    assert.deepEqual(timeline.map(step => [step.atMs,step.durationMs]), [[1500,1000],[5000,1000]])
    const share = await captures.createCaptureShare(userId,slot.id); assert.ok(share)
    assert.deepEqual(Buffer.from((await captures.sharedCapture(share.token))!.bytes),bytes)
    await captures.revokeCaptureShares(userId,slot.id)
    assert.equal(await captures.sharedCapture(share.token),null)
    assert.equal((await captures.runEvidence(userId,runId))?.captures.length,1)

    // The request scope has five connections. Every finalizer must retain
    // exactly one, including its nested account-write/storage transactions.
    const concurrentRows = await Promise.all(Array.from({ length:5 }, async () => {
      const nextRun = randomUUID()
      await pool.query(`INSERT INTO agent_runs(id,"userId","agentId",status) VALUES($1,$2,$3,'running')`, [nextRun,userId,agentId])
      await captures.openRecording({ userId,runId:nextRun,issueId:null,botId:null }, { title:'Concurrent synthetic recording',display:1,stopsAt:new Date(Date.now()+60_000) })
      const recording = await captures.currentRecording(nextRun); assert.ok(recording)
      return recording
    }))
    const concurrent = await Promise.all(concurrentRows.map(recording => captures.withRecordingFinalization(recording,
      current => captures.finishRecording(current,{bytes,durationMs:processed.durationMs,steps:processed.steps}))))
    assert.equal(concurrent.filter(result => !('error' in result)).length,5)

    const failedRun = randomUUID()
    await pool.query(`INSERT INTO agent_runs(id,"userId","agentId",status) VALUES($1,$2,$3,'running')`, [failedRun,userId,agentId])
    await captures.openRecording({ userId,runId:failedRun,issueId:null,botId:null }, { title:'Failure fixture',display:1,stopsAt:new Date(Date.now()+60_000) })
    const failureRow = await captures.currentRecording(failedRun); assert.ok(failureRow)
    const failure = await captures.withRecordingFinalization(failureRow, async () => { throw new Error('Synthetic provider failure') })
    assert.ok('error' in failure)
    assert.equal((await pool.query('SELECT status FROM run_captures WHERE id=$1',[failureRow.id])).rows[0].status,'failed', 'failed finalization is committed before returning')

    await t.test('an aborted object upload cannot become ready and its cleanup does not reuse the expired signal', async () => {
      const cancelledRun = randomUUID(), controller = new AbortController()
      await pool.query(`INSERT INTO agent_runs(id,"userId","agentId",status) VALUES($1,$2,$3,'running')`, [cancelledRun,userId,agentId])
      await captures.openRecording({ userId,runId:cancelledRun,issueId:null,botId:null }, { title:'Interrupted upload',display:1,stopsAt:new Date(Date.now()+60_000) })
      const recording = await captures.currentRecording(cancelledRun); assert.ok(recording)
      const writes: { method: string; path: string }[] = []
      const server = createServer((request, response) => {
        writes.push({ method: request.method!, path: request.url! })
        request.resume()
        if (request.method === 'PUT') {
          // The real HTTP upload reached storage, but no response arrives.
          // Cancel its actual fetch while this SQL finalizer still owns its lock.
          request.once('end', () => controller.abort())
        } else if (request.method === 'DELETE') response.writeHead(204).end()
        else response.writeHead(405).end()
      })
      const names = ['S3_ENDPOINT','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','S3_REGION'] as const
      const previous = names.map(name => process.env[name])
      try {
        server.listen(0, '127.0.0.1'); await once(server, 'listening')
        Object.assign(process.env, { S3_ENDPOINT:`http://127.0.0.1:${(server.address() as { port: number }).port}`,
          S3_BUCKET:'isolated-capture-fixture',S3_ACCESS_KEY_ID:'fixture',S3_SECRET_ACCESS_KEY:'fixture-secret',S3_REGION:'auto' })
        const result = await captures.withRecordingFinalization(recording,
          current => captures.finishRecording(current,{bytes,durationMs:processed.durationMs,steps:processed.steps},controller.signal))
        assert.ok(controller.signal.aborted)
        assert.ok('error' in result)
        assert.deepEqual(writes.map(write => write.method), ['PUT','DELETE'], 'the potentially stored unique key is cleaned after abort')
        assert.equal(writes[0].path,writes[1].path)
        assert.equal((await pool.query('SELECT status FROM run_captures WHERE id=$1',[recording.id])).rows[0].status,'failed',
          'the aborted upload commits failed after releasing its nested savepoint')
        assert.equal(await captures.readCapture(userId,recording.id),null)
      } finally {
        names.forEach((name,index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name]=previous[index] })
        server.closeAllConnections(); server.close()
      }
    })
  })
})
