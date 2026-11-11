#!/usr/bin/env node
/** Post-publication acceptance. Only random, local Compose projects and their
 * own PG17 volumes are mutated. The manifest, images, HTTP and updater are real. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { createServer as createPortReservation } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { githubRelease, hashProgram } from '../self-hosted-update.mjs'
import { assertPinnedImage, IMAGE_REPOSITORY } from '../self-hosted-update-policy.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const updater = join(repo, 'scripts/self-hosted-update.mjs')
const output = join(repo, '.artifacts/self-hosted/upgrade.json')
const tag = process.argv[2]
const evidence = { tag, startedAt: new Date().toISOString(), cases: [] }
// Never pass an application connection string, model credential, Compose
// override, remote Docker host or production secret into a disposable install.
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'DOCKER_CONFIG', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
const published = [
  { revision: '5c1e0522483d504f64de07066bcd35f603c44248', image: IMAGE_REPOSITORY + '@sha256:aab2790169e5a9473b9d7729f300c19f74743d0a5098dddd04f45a3c63f672af' },
  { revision: '43838a6efd6b66472b0c1f221829125bfb31fe34', image: IMAGE_REPOSITORY + '@sha256:b090447cf07be9eda002e5c401dcd269aa78566e170fa9b8ff4a8f8857087401' }
]

function command(program, args, opts = {}) {
  const result = spawnSync(program, args, { cwd: repo, env, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, ...opts })
  if (result.error) throw result.error
  return result
}
function checked(program, args, opts) {
  const result = command(program, args, opts)
  if (result.status !== 0) {
    // Keep the job failure useful. Commands never include the device token or DB password.
    throw new Error(program + ' ' + args[0] + ' failed (' + result.status + '): ' + (result.stderr || '').trim().slice(-1200))
  }
  return (result.stdout || '').trim()
}
function git(...args) { return checked('git', args) }
function docker(...args) { return checked('docker', args) }
function inventory(image) { return docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e', hashProgram) }
function digestFor(tagged) {
  const refs = JSON.parse(docker('image', 'inspect', tagged, '--format', '{{json .RepoDigests}}'))
  return assertPinnedImage(refs.find(ref => ref.startsWith(IMAGE_REPOSITORY + '@')))
}

function olderImage(release, sameSchema) {
  const tree = git('rev-parse', release.revision + ':drizzle')
  const candidates = published.filter(c => command('git', ['merge-base', '--is-ancestor', c.revision, release.revision]).status === 0)
  const tested = new Set()
  function tryCandidate({ revision, image }) {
    if (tested.has(revision) || revision === release.revision) return
    tested.add(revision)
    if ((git('rev-parse', revision + ':drizzle') === tree) !== sameSchema) return
    if (!image) {
      const ref = IMAGE_REPOSITORY + ':' + revision
      const inspection = command('docker', ['manifest', 'inspect', ref])
      if (inspection.status !== 0 && /manifest unknown|no such manifest/i.test(inspection.stderr)) return
      assert.equal(inspection.status, 0, 'GHCR candidate lookup failed: ' + revision)
      docker('pull', ref)
      image = digestFor(ref)
    } else docker('pull', image)
    const actual = docker('image', 'inspect', image, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}')
    assert.equal(actual, revision, 'old image OCI source')
    const migrations = inventory(image)
    assert.equal(migrations === release.migrations, sameSchema, 'old image migration inventory')
    return { image, revision, migrations }
  }
  for (const candidate of candidates) {
    const result = tryCandidate(candidate)
    if (result) return result
  }
  // Main's SHA-tag publisher may skip unrelated commits. Look back across
  // first-parent history and use only images whose revision and contents match.
  const history = git('rev-list', '--first-parent', release.revision + '^1').split('\n')
  for (const revision of history) {
    const result = tryCandidate({ revision })
    if (result) return result
  }
  throw new Error('No published prior image with the required migration inventory: ' + (sameSchema ? 'same' : 'different'))
}

const seed = `
BEGIN;
INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt")
VALUES (:'owner','Upgrade fixture',:'owner'||'@example.invalid',false,now(),now());
INSERT INTO mikka_workspaces (id,"userId",name,slug,kind)
SELECT :'workspace',:'owner','Upgrade fixture','fixture-'||:'workspace','personal'
WHERE NOT EXISTS (SELECT FROM mikka_workspaces WHERE "userId"=:'owner' AND kind='personal');
SELECT id AS workspace FROM mikka_workspaces WHERE "userId"=:'owner' AND kind='personal' \\gset
INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status)
SELECT :'workspace',:'owner','Upgrade fixture',:'owner'||'@example.invalid','admin','active'
WHERE NOT EXISTS (SELECT FROM mikka_workspace_members WHERE "workspaceId"=:'workspace' AND "userId"=:'owner');
INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority)
VALUES (:'task',:'owner',:'workspace','Persisted upgrade task','{"type":"doc","content":[]}','todo','normal');
INSERT INTO agents (id,"userId",harness,name,instructions)
VALUES (:'agent',:'owner','codex','Upgrade fixture','Complete the local fixture.');
INSERT INTO devices (id,"ownerId",name) VALUES (:'device',:'owner','Upgrade fixture device');
INSERT INTO device_tokens (id,"userId",name,"tokenHash") VALUES (:'tokenId',:'owner','Upgrade fixture token',:'tokenHash');
INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceTokenId","leaseExpiresAt",status,prompt)
VALUES (:'run',:'owner',:'task',:'agent',:'device',:'tokenId',now()+interval '1 hour','running','Persist through a self-hosted upgrade');
CREATE TABLE upgrade_acceptance_data (id uuid PRIMARY KEY, retained text NOT NULL, legacy_payload text);
INSERT INTO upgrade_acceptance_data VALUES (:'task',:'sentinel','test-only pre-contract data');
COMMIT;`
const readState = `
SELECT json_build_object('taskId',i.id,'title',i.title,'issueStatus',i.status,'runId',r.id,'runStatus',r.status,
  'stopReason',r."stopReason",'finishedAt',r."finishedAt",'retained',d.retained)
FROM issues i JOIN agent_runs r ON r."issueId"=i.id JOIN upgrade_acceptance_data d ON d.id=i.id
WHERE i.id=:'task' AND r.id=:'run';`

async function exercise(release, previous, migrationChanged) {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-upgrade-'))
  const project = 'mikka-upgrade-' + randomUUID().slice(0, 12)
  const options = { cwd: dir, env: { ...env, COMPOSE_PROJECT_NAME: project, MIKKA_UPDATE_DRAIN_HOOK: join(dir, 'drain'), MIKKA_UPDATE_VERIFY_HOOK: join(dir, 'verify') } }
  const composeArgs = ['compose', '--project-directory', dir, '-f', 'docker-compose.yml']
  const compose = (args, extra = {}) => checked('docker', [...composeArgs, ...args], { ...options, ...extra })
  const cli = (args, expectedError) => {
    const result = command(process.execPath, [updater, ...args], options)
    if (expectedError) {
      assert.notEqual(result.status, 0, 'updater must refuse ' + expectedError)
      assert.ok(result.stderr.trim().split(/\r?\n/).includes(expectedError), expectedError + ' missing: ' + result.stderr.trim().slice(-512))
      return expectedError
    }
    assert.equal(result.status, 0, 'updater: ' + result.stderr.trim().slice(-512))
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
  }
  const token = 'orv_' + randomBytes(32).toString('base64url')
  const ids = Object.fromEntries(['owner', 'workspace', 'task', 'agent', 'device', 'tokenId', 'run', 'sentinel'].map(key => [key, randomUUID()]))
  ids.tokenHash = createHash('sha256').update(token).digest('hex')
  const vars = Object.entries(ids).flatMap(([name, value]) => ['-v', name + '=' + value])
  const sql = (query, db = 'mikka') => compose(['exec', '-T', 'postgres', 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', ...vars, '-U', 'mikka', '-d', db], { input: query })
  const taskState = db => JSON.parse(sql(readState, db))
  const ledger = () => sql('SELECT name FROM schema_migrations ORDER BY name;').split('\n')
  const statePath = join(dir, '.mikka-updates')
  const drainFlag = join(dir, 'ingress-drained')
  const failureFlag = join(dir, 'fail-verify')
  const dataInVolume = () => compose(['exec', '-T', 'app', 'cat', '/data/upgrade-sentinel'])
  function runtime(expected) {
    const container = compose(['ps', '-q', 'app'])
    const id = docker('inspect', '--format', '{{.Image}}', container)
    assert.equal(id, docker('image', 'inspect', expected.image, '--format', '{{.Id}}'))
    const revision = docker('image', 'inspect', id, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}')
    assert.equal(revision, expected.revision)
    assert.ok(JSON.parse(docker('image', 'inspect', id, '--format', '{{json .RepoDigests}}')).includes(expected.image))
    const sockets = JSON.parse(docker('inspect', '--format', '{{json .Mounts}}', container))
    assert.equal(sockets.some(m => [m.Source, m.Destination].some(p => p?.endsWith('/docker.sock'))), false)
    return { container, id, revision, digest: expected.image.split('@')[1] }
  }
  const record = { baseline: previous, migrationChanged, project, taskId: ids.task, runId: ids.run }
  evidence.cases.push(record)
  let edge
  try {
    // Reserve a loopback port once; re-creating the app must keep the same
    // ingress target instead of asking Docker for a new ephemeral binding.
    const reservation = createPortReservation()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise(done => reservation.close(done))
    copyFileSync(join(repo, 'docker-compose.yml'), join(dir, 'docker-compose.yml'))
    writeFileSync(join(dir, '.env'), [
      'POSTGRES_PASSWORD=' + randomBytes(24).toString('hex'), 'MIKKA_IMAGE=' + previous.image,
      'MIKKA_PORT=' + port, 'BETTER_AUTH_URL=http://localhost:3000', ''
    ].join('\n'), { mode: 0o600 })
    writeFileSync(join(dir, 'drain'), '#!/bin/sh\nset -eu\ncase "$1" in enable) touch ingress-drained;; disable) rm -f ingress-drained;; *) exit 2;; esac\n', { mode: 0o700 })
    // Fail *after* startup, real migrations and API smoke. In the schema case
    // add a destructive contract to a fixture-only table, separately evidenced
    // from the real upstream SQL ledger. No business table is altered here.
    writeFileSync(join(dir, 'verify'), '#!/bin/sh\nset -eu\n[ -e fail-verify ] || exit 0\n' + (migrationChanged
      ? "docker compose -f docker-compose.yml exec -T postgres psql -Xq -v ON_ERROR_STOP=1 -U mikka -d mikka -c 'ALTER TABLE upgrade_acceptance_data DROP COLUMN legacy_payload'\n" : '') + 'exit 42\n', { mode: 0o700 })
    compose(['up', '-d', '--wait', '--wait-timeout', '240'])
    record.installed = runtime(previous)
    assert.equal(compose(['port', 'app', '3000']), '127.0.0.1:' + port, 'disposable loopback binding')
    // All external fixture requests use this ingress; the updater's in-
    // container readiness endpoint stays available while ingress is drained.
    edge = createServer((incoming, response) => {
      if (existsSync(drainFlag)) { response.writeHead(503).end(); return }
      const upstream = request({
        hostname: '127.0.0.1', port, path: incoming.url, method: incoming.method,
        headers: { ...incoming.headers, host: 'localhost:3000' }
      }, reply => { response.writeHead(reply.statusCode, reply.headers); reply.pipe(response) })
      upstream.on('error', () => { response.writeHead(502).end() })
      incoming.pipe(upstream)
    })
    edge.listen(0, '127.0.0.1')
    await once(edge, 'listening')
    const origin = 'http://127.0.0.1:' + edge.address().port + '/mikka'
    const api = (path, opts) => fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(15_000), ...opts })
    sql(seed)
    compose(['exec', '-T', 'app', 'node', '-e', "const fs=require('node:fs');fs.writeFileSync('/data/upgrade-sentinel',fs.readFileSync(0))"], { input: ids.sentinel })
    const running = taskState()
    assert.equal(running.runStatus, 'running')
    assert.equal(running.finishedAt, null)
    record.before = running
    const originalLedger = ledger()
    const flags = ['--ack-idle', ...(migrationChanged ? ['--allow-migrations'] : [])]
    record.refusal = cli(['apply', tag, ...flags], 'SELF_HOSTED_UPDATE_ACTIVE_TASKS')
    assert.deepEqual(runtime(previous), record.installed, 'running task was interrupted')
    assert.deepEqual(taskState(), running)
    const completion = await api('/v1/runs/' + ids.run + '/complete', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ stopReason: 'turn_ended' })
    })
    assert.equal(completion.status, 204, 'device completion')
    record.completion = { method: 'POST /mikka/v1/runs/[id]/complete', status: completion.status }
    const finished = taskState()
    assert.equal(finished.runStatus, 'stopped')
    assert.equal(finished.stopReason, 'turn_ended')
    assert.ok(finished.finishedAt)
    assert.equal(finished.retained, ids.sentinel)
    record.afterCompletion = finished

    const backup = cli(['backup'])
    assert.equal(backup.status, 'restore-verified')
    const restored = 'evidence_' + randomUUID().replaceAll('-', '')
    compose(['exec', '-T', 'postgres', 'createdb', '-U', 'mikka', '-T', 'template0', restored])
    const fd = openSync(backup.archive, 'r')
    try {
      compose(['exec', '-T', 'postgres', 'pg_restore', '-U', 'mikka', '--single-transaction', '--exit-on-error', '-d', restored], { stdio: [fd, 'pipe', 'pipe'] })
      assert.deepEqual(taskState(restored), finished)
      record.backup = { format: 'pg_dump -Fc', restoredDatabase: restored, matchedTaskAndRun: true }
    } finally {
      closeSync(fd)
      compose(['exec', '-T', 'postgres', 'dropdb', '-U', 'mikka', restored])
    }
    writeFileSync(failureFlag, 'after-startup', { mode: 0o600 })
    record.failure = cli(['apply', tag, ...flags], migrationChanged ? 'SELF_HOSTED_UPDATE_MIGRATION_RECOVERY_REQUIRED' : 'SELF_HOSTED_UPDATE_REVERTED_TO_PREVIOUS_IMAGE')
    record.afterFailure = runtime(migrationChanged ? release : previous)
    const newLedger = ledger()
    record.appliedMigrations = newLedger.filter(name => !originalLedger.includes(name))
    assert.deepEqual(newLedger.filter(name => originalLedger.includes(name)), originalLedger)
    assert.equal(record.appliedMigrations.length > 0, migrationChanged, 'actual migration ledger transition')
    assert.deepEqual(taskState(), finished)
    assert.equal(dataInVolume(), ids.sentinel)
    const hasLegacy = sql("SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_name='upgrade_acceptance_data' AND column_name='legacy_payload');")
    assert.equal(hasLegacy, migrationChanged ? 'f' : 't')
    assert.equal(existsSync(drainFlag), migrationChanged)
    const afterFailureHttp = await api('/api/version')
    record.afterFailure.ingressStatus = afterFailureHttp.status
    assert.equal(afterFailureHttp.status, migrationChanged ? 503 : 200)
    await afterFailureHttp.arrayBuffer()
    record.fixtureContractColumn = migrationChanged ? 'irreversibly dropped by post-start verification fixture' : 'retained'
    rmSync(failureFlag)
    const retry = migrationChanged ? 'recover' : 'apply'
    record.recovery = { command: retry, result: cli([retry, tag, ...flags]).status }
    record.afterRecovery = runtime(release)
    assert.equal(existsSync(drainFlag), false)
    assert.equal(dataInVolume(), ids.sentinel)
    assert.deepEqual(taskState(), finished)
    assert.deepEqual(ledger(), newLedger)
    const version = await api('/api/version')
    assert.equal(version.status, 200)
    assert.equal((await version.json()).build, release.revision)
    record.smoke = JSON.parse(compose(['exec', '-T', '-e', 'MIKKA_EXPECTED_REVISION=' + release.revision, 'app', 'node', 'scripts/self-hosted-update-smoke.mjs']))
    assert.equal(record.smoke.status, 'passed')
    const last = JSON.parse(readFileSync(join(statePath, 'last-success.json'), 'utf8'))
    assert.deepEqual([last.tag, last.revision, last.image], [tag, release.revision, release.image])
    record.cliCheck = cli(['check', tag])
    assert.equal(record.cliCheck.image, release.image)
    record.after = taskState()
    record.status = 'passed'
  } finally {
    if (edge?.listening) await new Promise(resolveClose => edge.close(resolveClose))
    try { compose(['down', '--volumes', '--remove-orphans']) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

try {
  const context = docker('context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}')
  assert.ok(context.startsWith('unix:///'), 'local Unix Docker context required')
  const release = await githubRelease(tag)
  assertPinnedImage(release.image)
  assert.equal(git('rev-parse', 'HEAD'), release.revision, 'driver must be the published revision')
  if (process.env.EXPECTED_RELEASE_DIGEST) assert.equal(release.image.split('@')[1], process.env.EXPECTED_RELEASE_DIGEST)
  if (process.env.MIKKA_EXPECTED_REVISION) assert.equal(release.revision, process.env.MIKKA_EXPECTED_REVISION)
  evidence.release = release
  docker('pull', release.image)
  assert.equal(inventory(release.image), release.migrations)
  for (const same of [true, false]) await exercise(release, olderImage(release, same), !same)
  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'failed'
  evidence.reason = error.message
  console.error(error.message)
  process.exitCode = 1
} finally {
  evidence.finishedAt = new Date().toISOString()
  mkdirSync(resolve(output, '..'), { recursive: true })
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n')
}
