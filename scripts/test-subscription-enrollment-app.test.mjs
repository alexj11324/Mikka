import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { enrollmentContainerArgs, initializeSnapshotIndex, snapshotIndexRecords } from './test-subscription-enrollment-app.mjs'

const revision = '1'.repeat(40)

test('the snapshot index contains only copied tracked files and rejects unresolved merges', () => {
  const route = 'app/api/subscriptions/enrollments/route.ts'
  const executable = 'scripts/build-subscription-worker.mjs'
  const omitted = '.env.local'
  const records = `100644 ${revision} 0\t${route}\0` +
    `100755 ${revision} 0\t${executable}\0` +
    `100644 ${revision} 0\t${omitted}\0`
  const selected = snapshotIndexRecords(records, new Set([route, executable, 'untracked-local.ts']))
  assert.equal(selected, `100644 ${revision} 0\t${route}\0` + `100755 ${revision} 0\t${executable}\0`)
  assert.throws(() => snapshotIndexRecords(`100644 ${revision} 2\t${route}\0`, new Set([route])), /unresolved merges/)
  assert.throws(() => snapshotIndexRecords(`100644 ${revision} 0 ${route}\0`, new Set([route])), /malformed/)
})

test('real Git can list the isolated snapshot without a commit, source objects or source config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-enrollment-index-test-'))
  const gitEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  try {
    const route = 'app/api/subscriptions/enrollments/route.ts'
    const content = 'export async function POST() { return new Response(null, { status: 401 }) }\n'
    const oid = execFileSync('git', ['hash-object', '--stdin'], { env: gitEnv, input: content, encoding: 'utf8' }).trim()
    await mkdir(dirname(join(directory, route)), { recursive: true })
    await writeFile(join(directory, route), content)
    await writeFile(join(directory, 'untracked-local.ts'), 'not an indexed route\n')
    initializeSnapshotIndex(directory, snapshotIndexRecords(`100644 ${oid} 0\t${route}\0`, new Set([route])))
    const tracked = execFileSync('git', ['ls-files', '-z', '--', 'app'], { cwd: directory, env: gitEnv, encoding: 'utf8' })
    assert.equal(tracked, `${route}\0`)
    const indexed = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: directory, env: gitEnv, encoding: 'utf8' })
    assert.equal(indexed, `100644 ${oid} 0\t${route}\0`)
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: directory, env: gitEnv, stdio: 'ignore' }).status, 0)
    assert.notEqual(spawnSync('git', ['cat-file', '-e', oid], { cwd: directory, env: gitEnv, stdio: 'ignore' }).status, 0)
    assert.doesNotMatch(await readFile(join(directory, '.git/config'), 'utf8'), /\[(?:remote|credential|include)/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the runner preserves its container boundary and mounts only its Vite cache writable', () => {
  const settings = {
    source: '/source', snapshot: '/private/run/app', viteCache: '/private/run/vite-cache',
    certificate: '/private/run/cert.pem', name: 'mikka-enrollment-test-fixture', port: 31234,
    env: { VERCEL_GIT_COMMIT_SHA: revision, MIKKA_DEV_SKIP_ENV_FILES: '1' },
  }
  const args = enrollmentContainerArgs(settings)
  assert.deepEqual(args.slice(0, 9), ['run', '-d', '--name', settings.name, '--network=host', '--memory=4g', '--cpus=2', '--user', `${process.getuid()}:${process.getgid()}`])
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '-v'), [
    '/private/run/app:/workspace/Mikka',
    '/source/node_modules:/workspace/Mikka/node_modules:ro',
    '/source/packages/protocol/node_modules:/workspace/Mikka/packages/protocol/node_modules:ro',
    '/source/apps/frontend/node_modules:/workspace/Mikka/apps/frontend/node_modules:ro',
    '/private/run/vite-cache:/workspace/Mikka/apps/frontend/node_modules/.vite',
    '/private/run/cert.pem:/tmp/vault-ca.pem:ro',
  ])
  assert.ok(args.includes(`VERCEL_GIT_COMMIT_SHA=${revision}`))
  assert.ok(args.includes('MIKKA_DEV_SKIP_ENV_FILES=1'))
  assert.deepEqual(args.slice(-7), [
    'node@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a',
    'node', 'apps/api/scripts/dev.mjs', '--host', '127.0.0.1', '--port', '31234',
  ])
  assert.throws(() => enrollmentContainerArgs({ ...settings, env: {} }))
  assert.throws(() => enrollmentContainerArgs({ ...settings, env: { VERCEL_GIT_COMMIT_SHA: 'main' } }))
})
