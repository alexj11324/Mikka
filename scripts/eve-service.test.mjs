import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { startEveService } from './eve-service.mjs'

for (const development of [false,true]) test(`self-hosted ${development?'development':'packaged'} peer isolates Workflow storage and reads its app resources`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'eve-sidecar-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory=join(root,development?'apps/eve':'eve')
  await mkdir(join(directory, 'server'), { recursive: true })
  await writeFile(join(directory, 'server/index.mjs'), 'export default {}')
  await writeFile(join(directory, 'mikka-eve-build.json'), JSON.stringify({ version: 1, eve: '1.0.0-rc.9', revision: 'a'.repeat(40) }))
  const data = join(root, 'data')
  const env = { MIKKA_DATA_DIR: data, WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_LOCAL_DATA_DIR: '/data/workflow', WORKFLOW_LOCAL_BASE_URL: 'https://main.test',
    NITRO_SSL_CERT: 'installation-certificate', NITRO_SSL_KEY: 'installation-tls-key', NITRO_UNIX_SOCKET: '/run/mikka/frontend.sock' }
  let spawned, stopped = 0
  const service = await startEveService({ root, env, development, allocatePort: async () => 43127, spawnProcess: (_command, _args, options) => {
    spawned = options
    const child = new EventEmitter()
    child.exitCode = null; child.signalCode = null
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = signal => { assert.equal(signal, 'SIGTERM'); stopped++; child.exitCode = 0; child.emit('exit', 0) }
    queueMicrotask(() => child.stdout.write('➜ Listening on: http://127.0.0.1:43127/\n'))
    return child
  } })
  assert.equal(env.MIKKA_EVE_ORIGIN, 'http://127.0.0.1:43127')
  assert.equal(spawned.env.WORKFLOW_LOCAL_BASE_URL, 'http://127.0.0.1:3000/mikka/api/agents')
  assert.equal(spawned.env.EVE_PUBLIC_ROUTE_PREFIX, '')
  assert.equal(spawned.env.MIKKA_RUNTIME_RESOURCE_ROOT, development ? root : directory)
  assert.equal(spawned.env.WORKFLOW_LOCAL_DATA_DIR, join(data, 'eve-workflow'))
  assert.equal(await realpath(join(directory, '.eve/.workflow-data')), join(data, 'eve-workflow'))
  assert.equal(env.WORKFLOW_LOCAL_DATA_DIR, '/data/workflow')
  for (const key of ['NITRO_SSL_CERT', 'NITRO_SSL_KEY', 'NITRO_UNIX_SOCKET']) {
    assert.equal(spawned.env[key], undefined, `the loopback HTTP peer inherited ${key}`)
    assert.ok(env[key], `the public listener still needs ${key}`)
  }
  assert.equal(spawned.cwd, directory)
  await service.close(); await service.close()
  assert.equal(stopped, 1)
})

test('native development cwd can load the real cookie-auth resource from its explicit app root',()=>{
  const root=fileURLToPath(new URL('../',import.meta.url))
  const require=createRequire(import.meta.url)
  const module=new URL('../lib/abuse/signup.ts',import.meta.url).href
  const result=spawnSync(process.execPath,['--import',require.resolve('tsx'),'--import',join(root,'scripts/server-test.mjs'),'--input-type=module','-e',`const signup=await import(${JSON.stringify(module)});if(!signup.disposableEmail('fixture@10minutemail.com'))throw new Error('AUTH_RESOURCE_NOT_LOADED')`],{
    cwd:join(root,'apps/eve'),env:{...process.env,MIKKA_RUNTIME_RESOURCE_ROOT:root},encoding:'utf8',timeout:15000,
  })
  assert.equal(result.status,0,result.stderr)
})

test('managed output and an explicitly supplied peer never spawn another process', async () => {
  for (const env of [{ VERCEL: '1' }, { MIKKA_EVE_ORIGIN: 'https://peer.test' }]) {
    const service = await startEveService({ env, spawnProcess: () => { throw new Error('MUST_NOT_SPAWN') } })
    await service.close()
  }
})

test('startup preserves an existing session directory instead of replacing its data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'eve-preserve-storage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'eve/server'), { recursive: true })
  await mkdir(join(root, 'eve/.eve/.workflow-data'), { recursive: true })
  await writeFile(join(root, 'eve/.eve/.workflow-data/history'), 'recorded-session')
  await writeFile(join(root, 'eve/server/index.mjs'), 'export default {}')
  await writeFile(join(root, 'eve/mikka-eve-build.json'), JSON.stringify({ version: 1, eve: '1.0.0-rc.9', revision: 'a'.repeat(40) }))
  await assert.rejects(startEveService({ root, env: {}, allocatePort: async () => 43127,
    spawnProcess: () => { throw new Error('MUST_NOT_SPAWN') } }), /EVE_SERVICE_STORAGE_MISMATCH/)
  assert.equal(await readFile(join(root, 'eve/.eve/.workflow-data/history'), 'utf8'), 'recorded-session')
})
