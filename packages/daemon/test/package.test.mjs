import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))

test('registry-installed tarball runs its CLI and a real mock-daemon git task without workspace dependencies', { timeout: 240_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'mikka-package-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  // Preserve the managed network proxy/CA, but never pass registry tokens,
  // user npm config, model credentials, NODE_PATH or a TypeScript loader.
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8' }
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  const userConfig = join(temporary, 'user.npmrc'), globalConfig = join(temporary, 'global.npmrc')
  await Promise.all([writeFile(userConfig, ''), writeFile(globalConfig, '')])
  const npmOptions = ['--userconfig', userConfig, '--globalconfig', globalConfig, '--cache', join(temporary, 'npm-cache'), '--registry', 'https://registry.npmjs.org']
  const packed = JSON.parse(execFileSync('npm', ['pack', join(root, 'dist'), '--json', '--ignore-scripts', '--pack-destination', temporary, ...npmOptions], { encoding: 'utf8', env, timeout: 30_000, killSignal: 'SIGKILL' }))[0]
  assert.ok(packed.files.length > 10)
  assert.ok(packed.files.every(file => !file.path.endsWith('.ts') && !file.path.startsWith('node_modules/')))
  const installation = join(temporary, 'installation')
  await mkdir(installation)
  await writeFile(join(installation, 'package.json'), JSON.stringify({ private: true }))
  execFileSync('npm', ['install', join(temporary, packed.filename), '--prefix', installation, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', ...npmOptions], { encoding: 'utf8', cwd: installation, env, timeout: 120_000, killSignal: 'SIGKILL' })
  const sourceManifest = JSON.parse(await readFile(join(root, 'dist/package.json'), 'utf8'))
  const installed = join(installation, 'node_modules', sourceManifest.name)
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@aspectlylabs/mikka')
  assert.equal(manifest.private, false)
  assert.equal(manifest.bin.mikka, './mikka.js')
  assert.ok(!manifest.dependencies['@mikka/protocol'])
  assert.ok(!manifest.dependencies.tsx)
  assert.ok(Object.values(manifest.dependencies).every(version => !version.startsWith('workspace:')))
  for (const path of Object.values(manifest.exports)) assert.ok((await readFile(join(installed, path))).length > 0)
  // Check actual npm resolution, including on case-insensitive filesystems:
  // every runtime dependency must resolve inside this fresh installation.
  const requireInstalled = createRequire(join(installed, 'package.json'))
  for (const dependency of Object.keys(manifest.dependencies)) {
    const dependencyPath = await realpath(requireInstalled.resolve(dependency))
    assert.ok(dependencyPath.startsWith((await realpath(installation)) + sep))
  }
  const runtimeEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_ENV: 'test', MIKKA_TEST_MODE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: userConfig }
  const command = join(installed, 'mikka.js')
  const help = execFileSync(process.execPath, [command, '--help'], { encoding: 'utf8', cwd: temporary, env: runtimeEnv, timeout: 20_000, killSignal: 'SIGKILL' })
  assert.match(help, /mikka daemon login/)
  const installedCommand = join(installation, 'node_modules', '.bin', 'mikka')
  const installedHelp = execFileSync(installedCommand, ['--help'], { encoding: 'utf8', cwd: temporary, env: runtimeEnv, timeout: 20_000, killSignal: 'SIGKILL' })
  assert.match(installedHelp, /mikka daemon login/)
  const data = join(temporary, 'data')
  const token = `orv_${'t'.repeat(43)}`
  execFileSync(installedCommand, ['daemon', 'login', '--token', token, '--data-dir', data], { cwd: temporary, env: runtimeEnv, stdio: 'pipe', timeout: 20_000, killSignal: 'SIGKILL' })
  assert.equal(JSON.parse(await readFile(join(data, 'device.json'), 'utf8')).credential, token)
  // These child scripts are resolved relative to bundled entries at runtime.
  for (const asset of ['mikka-mcp.mjs', 'agents/native-container.mjs', 'computer/proxy.mjs', 'computer/driver.mjs', 'fixtures/success-edit.jsonl']) {
    assert.ok((await readFile(join(installed, asset))).length > 0)
  }
  const output = execFileSync(process.execPath, [join(root, 'test/package-runtime.mjs'), installed, temporary], { cwd: installation, env: runtimeEnv, encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL' })
  assert.match(output, /PACKAGED_MOCK_DAEMON_GIT_TASK_PASSED/)
  assert.ok(!output.includes(token))
  console.log(JSON.stringify({ package: manifest.name, version: manifest.version,
    tarballSha256: createHash('sha256').update(await readFile(join(temporary, packed.filename))).digest('hex'),
    installedFrom: 'local tarball with fresh public-registry dependencies', runtime: 'packaged mock daemon and real local-bare git task',
    realProvider: false, published: false }))
})
