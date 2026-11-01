import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedRun, seedUser } from '../../tests/support/workspace-admin-db'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
test('portable account files preserve owned bytes/versions and abort missing, altered, revoked or cancelled exports', { skip: !dbUrl, timeout: 30000 }, async t => {
  const database = new Pool({ connectionString: dbUrl, max: 4 })
  const owner = await seedUser(database, 'portable-owner'), peer = await seedUser(database, 'portable-peer')
  const ownerAgent = await seedAgent(database, owner), peerAgent = await seedAgent(database, peer)
  const ownerRun = await seedRun(database, { userId: owner, agentId: ownerAgent }), peerRun = await seedRun(database, { userId: peer, agentId: peerAgent })
  const objects = new Map<string, Buffer>(), fetched: string[] = []
  const server = createServer((request, response) => {
    const key = request.url!.slice(1), bytes = objects.get(key)
    fetched.push(key)
    if (!bytes) { response.writeHead(404).end(); return }
    response.writeHead(200)
    // Deliberately split byte triples; the export must preserve binary base64 across chunk boundaries.
    for (let offset = 0; offset < bytes.length; offset += 65531) response.write(bytes.subarray(offset, offset + 65531))
    response.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address === 'object')
  mock.module('../artifacts/storage.ts', { namedExports: { getArtifactObjectStream: async (key: string, signal: AbortSignal) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/${key}`, { signal })
    if (!response.ok || !response.body) throw Error('Object fixture unavailable')
    return response.body
  } } })
  const { accountExportFiles, accountExportBody } = await import('./export-files')
  const { buildAccountExport } = await import('./export')
  const { pool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  const artifactIds: string[] = []
  t.after(async () => {
    await database.query('DELETE FROM artifacts WHERE id=ANY($1::uuid[])', [artifactIds])
    await database.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [[ownerRun, peerRun]])
    await database.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [[ownerAgent, peerAgent]])
    await database.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer]])
    await Promise.all([database.end(), pool.end(), workspacePool.end()])
    server.closeAllConnections(); server.close()
  })
  async function artifact(userId: string, versions: Buffer[], remote = false) {
    const id = randomUUID(); artifactIds.push(id)
    await database.query('INSERT INTO artifacts(id,"userId",kind,title,"latestVersion") VALUES($1,$2,\'markdown\',\'Portable document\',$3)', [id, userId, versions.length])
    const versionIds = []
    for (let index = 0; index < versions.length; index++) {
      const versionId = randomUUID(), key = `owned-object-${versionId}`, bytes = versions[index]
      objects.set(key, bytes); versionIds.push(versionId)
      await database.query('INSERT INTO artifact_versions(id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES($1,$2,$3,$4,$5,$6,$7,\'Fixture\')', [versionId, id, index + 1, key, remote ? null : bytes.toString('utf8'), hash(bytes), bytes.length])
    }
    return { id, versionIds }
  }
  const repo = mkdtempSync(join(tmpdir(), 'mikka-export-checkpoint-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args])
  git('init', '--quiet', '--template=')
  writeFileSync(join(repo, 'file'), 'original source\n')
  git('add', 'file')
  git('-c', 'user.name=Export fixture', '-c', 'user.email=export@example.invalid', 'commit', '--quiet', '-m', 'checkpoint base')
  const baseCommit = git('rev-parse', 'HEAD').toString().trim()
  const source = 'owned source — 原文\n'
  writeFileSync(join(repo, 'file'), source)
  const first = Buffer.from('first version — 原文'), second = Buffer.from('second version 😀\n'), patch = gzipSync(git('diff', '--binary', baseCommit))
  const takenAt = new Date('2026-10-31T12:00:00.000Z'), updatedAt = new Date('2026-10-31T12:00:30.000Z')
  const own = await artifact(owner, [first, second], true)
  const foreign = await artifact(peer, [Buffer.from('peer private file')], true)
  const captureId = randomUUID(), capture = Buffer.from([0, 1, 2, 253, 254, 255, 7])
  const captureKey = `capture-object-${captureId}`; objects.set(captureKey, capture)
  await database.query(`INSERT INTO run_captures(id,"userId","runId",kind,"contentType",source,status,title,"storageKey",sha256,size) VALUES($1,$2,$3,'image','image/png','local','ready','Owned capture',$4,$5,$6)`, [captureId, owner, ownerRun, captureKey, hash(capture), capture.length])
  await database.query('INSERT INTO run_checkpoints("runId","userId","baseCommit",patch,files,"takenAt","updatedAt") VALUES($1,$2,$3,$4,1,$5,$6)', [ownerRun, owner, baseCommit, patch, takenAt, updatedAt])
  await database.query('INSERT INTO run_checkpoints("runId","userId","baseCommit",patch,files,"takenAt") VALUES($1,$2,$3,$4,1,now())', [peerRun, peer, 'b'.repeat(40), gzipSync('peer private checkpoint')])
  const data = await buildAccountExport(owner)
  const options = { database, signal: new AbortController().signal, assertCurrent: async () => {} }
  await t.test('all owned versions, binary capture and masked checkpoint round-trip; peer object IDs never reach storage', async () => {
    const files = await accountExportFiles(owner, database)
    assert.equal(files.length, 4)
    assert.equal(files.some(file => foreign.versionIds.includes(file.id)), false)
    assert.equal(files.some(file => file.id === peerRun), false)
    const result = await new Response(accountExportBody(data, files, owner, options)).json()
    assert.deepEqual(result.fileManifest, { complete: true, files: 4, exported: 4, unavailable: 0, bytes: first.length + second.length + capture.length + patch.length })
    const actual = (id: string) => Buffer.from(result.files.find((file: { id: string }) => file.id === id).content, 'base64')
    assert.deepEqual(actual(own.versionIds[0]), first); assert.deepEqual(actual(own.versionIds[1]), second)
    assert.deepEqual(actual(captureId), capture); assert.deepEqual(actual(ownerRun), patch)
    const checkpoint = result.files.find((file: { id: string }) => file.id === ownerRun)
    assert.equal(checkpoint.baseCommit, baseCommit)
    assert.equal(checkpoint.files, 1)
    assert.equal(checkpoint.takenAt, takenAt.toISOString())
    assert.equal(checkpoint.updatedAt, updatedAt.toISOString())
    assert.equal(checkpoint.size, patch.length); assert.equal(checkpoint.sha256, hash(patch))
    // The exported commit identifies the real patch's base, without a new import/recovery subsystem.
    git('reset', '--hard', checkpoint.baseCommit)
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'apply', '--binary', '-'], { input: gunzipSync(actual(ownerRun)) })
    assert.equal(readFileSync(join(repo, 'file'), 'utf8'), source)
    assert.equal(result.files.find((file: { id: string }) => file.id === own.versionIds[1]).version, 2)
    assert.equal(JSON.stringify(result).includes('storageKey'), false)
    assert.ok(fetched.every(key => !foreign.versionIds.some(id => key.includes(id))))
  })
  await t.test('a foreign file descriptor still fails ownership when explicitly supplied to the stream', async () => {
    const files = await accountExportFiles(peer, database), before = fetched.length
    assert.equal(files.length, 2)
    for (const file of files) await assert.rejects(new Response(accountExportBody(data, [file], owner, options)).text(), /no longer available/)
    assert.equal(fetched.length, before)
  })
  await t.test('missing or corrupt object bytes cannot become a complete valid JSON export', async () => {
    const [file] = (await accountExportFiles(owner, database)).filter(file => file.id === own.versionIds[0])
    const key = `owned-object-${file.id}`, saved = objects.get(key)!
    objects.delete(key)
    await assert.rejects(new Response(accountExportBody(data, [file], owner, options)).text(), /Object fixture unavailable/)
    objects.set(key, Buffer.from('altered'))
    await assert.rejects(new Response(accountExportBody(data, [file], owner, options)).text(), /integrity mismatch/)
    objects.set(key, saved)
  })
  await t.test('current owner is checked again after storage I/O; changed ownership never finishes the file', async () => {
    const [file] = (await accountExportFiles(owner, database)).filter(file => file.id === own.versionIds[0])
    let checks = 0
    await assert.rejects(new Response(accountExportBody(data, [file], owner, { ...options, assertCurrent: async () => {
      if (++checks === 3) await database.query('UPDATE artifacts SET "userId"=$1 WHERE id=$2', [peer, own.id])
    } })).text(), /ownership changed/)
    await database.query('UPDATE artifacts SET "userId"=$1 WHERE id=$2', [owner, own.id])
  })
  await t.test('link/session authority revocation during a large file and consumer cancellation stop without a completion manifest', async () => {
    const large = await artifact(owner, [Buffer.alloc(2 * 1024 * 1024 + 7, 97)], true)
    const [file] = (await accountExportFiles(owner, database)).filter(file => file.id === large.versionIds[0])
    let checks = 0
    await assert.rejects(new Response(accountExportBody(data, [file], owner, { ...options, assertCurrent: async () => {
      if (++checks === 3) throw Error('Export link revoked')
    } })).text(), /Export link revoked/)
    const controller = new AbortController(), body = accountExportBody(data, [file], owner, { ...options, signal: controller.signal })
    const reader = body.getReader(); await reader.read(); controller.abort()
    await assert.rejects(reader.read(), { name: 'AbortError' }); reader.releaseLock()
    const cancelled = accountExportBody(data, [file], owner, options).getReader()
    await cancelled.read(); await cancelled.cancel()
    assert.equal((await cancelled.read()).done, true)
  })
  await t.test('recordings not ready and oversized checkpoints are explicitly incomplete, never empty successful files', async () => {
    await database.query('UPDATE run_captures SET status=\'failed\' WHERE id=$1', [captureId])
    await database.query('UPDATE run_checkpoints SET "unavailableReason"=\'too_large\' WHERE "runId"=$1', [ownerRun])
    const files = (await accountExportFiles(owner, database)).filter(file => file.id === captureId || file.id === ownerRun)
    const result = await new Response(accountExportBody(data, files, owner, options)).json()
    assert.deepEqual(result.fileManifest, { complete: false, files: 2, exported: 0, unavailable: 2, bytes: 0 })
    assert.ok(result.files.every((file: { content: unknown; unavailable: string }) => file.content === null && file.unavailable))
    const checkpoint = result.files.find((file: { id: string }) => file.id === ownerRun)
    assert.equal(checkpoint.baseCommit, baseCommit)
    assert.equal(checkpoint.files, 1)
    assert.equal(checkpoint.takenAt, takenAt.toISOString())
    assert.equal(checkpoint.updatedAt, updatedAt.toISOString())
    await database.query('UPDATE run_captures SET "userId"=$1 WHERE id=$2', [peer, captureId])
    await assert.rejects(new Response(accountExportBody(data, files.filter(file => file.id === captureId), owner, options)).text(), /no longer available/)
  })
})
