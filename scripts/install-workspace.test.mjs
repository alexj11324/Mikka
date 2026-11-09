import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, copyFile, symlink, stat, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'

const require = createRequire(import.meta.url)
const upstream = dirname(require.resolve('ffmpeg-static/package.json'))
async function execute(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code: code ?? 1, output }))
  })
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-ffmpeg-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'ffmpeg-static')
  await mkdir(join(directory, 'node_modules'), { recursive: true })
  for (const file of ['install.js', 'index.js', 'package.json']) await copyFile(join(upstream, file), join(directory, file))
  const upstreamRequire = createRequire(join(upstream, 'package.json'))
  const pkg = JSON.parse(await readFile(join(upstream, 'package.json')))
  for (const name of Object.keys(pkg.dependencies)) {
    const destination = join(directory, 'node_modules', name)
    await mkdir(dirname(destination), { recursive: true })
    await symlink(dirname(upstreamRequire.resolve(name + '/package.json')), destination)
  }
  const requests = [], state = { fail: true }
  const server = createServer((request, response) => {
    requests.push(request.url)
    if (request.url.endsWith('.LICENSE') && state.fail) { response.writeHead(504); response.end(); return }
    const content = request.url.endsWith('.gz') ? gzipSync('#!/bin/sh\necho controlled-ffmpeg-fixture\n') : Buffer.from('controlled upstream metadata\n')
    response.writeHead(200, { 'content-length': content.length, 'cache-control': 'no-store' })
    response.end(content)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const env = { ...process.env, CI: '1', FFMPEG_BINARIES_URL: `http://127.0.0.1:${server.address().port}`, XDG_CACHE_HOME: join(root, 'cache') }
  for (const key of ['FFMPEG_BIN', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'npm_config_platform', 'npm_config_arch']) delete env[key]
  const install = () => execute(process.execPath, [join(directory, 'install.js')], { cwd: root, env })
  return { root, directory, env, state, requests, install, manifest: join(directory, 'package.json') }
}
const loadFix = () => import('./install-workspace.mjs')

test('real upstream LICENSE 504 leaves a binary; a blind retry falsely succeeds; wrapper repairs all assets', async t => {
  const f = await fixture(t)
  const failed = await f.install()
  assert.equal(failed.code, 1)
  assert.match(failed.output, /statusCode: 504/)
  assert.ok((await stat(join(f.directory, 'ffmpeg'))).size > 0)
  await assert.rejects(stat(join(f.directory, 'ffmpeg.LICENSE')), { code: 'ENOENT' })
  const blind = await f.install()
  assert.equal(blind.code, 0)
  assert.match(blind.output, /installed already/)
  await assert.rejects(stat(join(f.directory, 'ffmpeg.LICENSE')), { code: 'ENOENT' })
  f.state.fail = false
  const { installWorkspace } = await loadFix()
  assert.equal(await installWorkspace({ cwd: f.root, env: f.env, packageJson: f.manifest,
    run: (command, args, options) => command === 'pnpm' ? Promise.resolve({ code: 0, output: '' }) : execute(command, args, options) }), 0)
  for (const file of ['ffmpeg', 'ffmpeg.README', 'ffmpeg.LICENSE']) assert.ok((await stat(join(f.directory, file))).size > 0)
  assert.ok(f.requests.filter(path => path.endsWith('.LICENSE')).length >= 7)
})

test('classified install failure retries the real installer then completes the frozen pnpm install', async t => {
  const f = await fixture(t), { installWorkspace } = await loadFix()
  f.state.fail = false
  let pnpmCalls = 0
  const code = await installWorkspace({ cwd: f.root, env: f.env, packageJson: f.manifest, run: (command, args, options) => {
    if (command !== 'pnpm') return execute(command, args, options)
    assert.deepEqual(args, ['install', '--frozen-lockfile'])
    return Promise.resolve(++pnpmCalls === 1 ? { code: 1, output: '.../node_modules/ffmpeg-static install: statusCode: 504\n.../node_modules/ffmpeg-static install: Failed' } : { code: 0, output: '' })
  } })
  assert.equal(code, 0)
  assert.equal(pnpmCalls, 2)
})

test('persistent HTTP 504 is bounded and never becomes success through the upstream binary fast path', async t => {
  const f = await fixture(t), { installWorkspace } = await loadFix()
  let installers = 0
  const code = await installWorkspace({ cwd: f.root, env: f.env, packageJson: f.manifest, run: (command, args, options) => {
    if (command === 'pnpm') return Promise.resolve({ code: 1, output: '.../node_modules/ffmpeg-static install: statusCode: 504\n.../node_modules/ffmpeg-static install: Failed' })
    installers++
    return execute(command, args, options)
  } })
  assert.equal(code, 1)
  assert.equal(installers, 2)
  await assert.rejects(stat(join(f.directory, 'ffmpeg.LICENSE')), { code: 'ENOENT' })
})

test('unrelated pnpm errors retain their status and do not delete generated or external files', async t => {
  const f = await fixture(t), { installWorkspace } = await loadFix()
  const external = join(f.root, 'external-ffmpeg')
  await writeFile(external, 'owned by operator\n')
  for (const [env, output] of [[f.env, 'unrelated postinstall HTTP 504'], [{ ...f.env, FFMPEG_BIN: external }, '.../node_modules/ffmpeg-static install: statusCode: 504\n.../node_modules/ffmpeg-static install: Failed']]) {
    let calls = 0
    assert.equal(await installWorkspace({ cwd: f.root, env, packageJson: f.manifest, run: async () => { calls++; return { code: 23, output } } }), 23)
    assert.equal(calls, 1)
    assert.equal(await readFile(external, 'utf8'), 'owned by operator\n')
  }
})

test('successful ffmpeg output cannot attribute another package HTTP 504 to ffmpeg', async t => {
  const f = await fixture(t), { installWorkspace } = await loadFix()
  const files = ['ffmpeg', 'ffmpeg.README', 'ffmpeg.LICENSE']
  for (const file of files) await writeFile(join(f.directory, file), 'complete original ' + file + '\n')
  let calls = 0
  const result = await installWorkspace({ cwd: f.root, env: f.env, packageJson: f.manifest, run: async () => {
    calls++
    return calls === 1 ? { code: 23, output: '.../node_modules/ffmpeg-static install: Done\n.../other-package postinstall: HTTP 504\nELIFECYCLE Command failed with exit code 23' } : { code: 0, output: '' }
  } })
  assert.equal(result, 23)
  assert.equal(calls, 1)
  for (const file of files) assert.equal(await readFile(join(f.directory, file), 'utf8'), 'complete original ' + file + '\n')
})
