import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installFailure, InstallProcessError, nodeDiscoveryScript } from './local-install'
import { runProcess, SshInstaller, type SshInstallState } from './ssh-install'

test('installation failure keeps complete output beyond the old 4 KB stderr tail', async () => {
  const rootCause = 'npm error code EACCES: /usr/local/lib/node_modules/@aspectlylabs'
  const warning = 'npm warn deprecated @opentelemetry/core@2.12.0\n'.repeat(200)
  let failure: unknown
  try { await runProcess(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(rootCause + '\n' + warning)});process.exit(1)`]) } catch (error) { failure = error }
  assert.ok(failure instanceof InstallProcessError)
  assert.equal(failure.stderr, rootCause + '\n' + warning)
  assert.deepEqual(installFailure(failure, 'install'), { code: 'installer_failed', cause: 'npm_permission', remedy: 'check_user_directory' })
  assert.equal(installFailure(new Error('npm error EACCES ~/.npm/_cacache is root-owned'), 'install').cause, 'npm_cache_permission')
})

test('local install uses its own npm prefix and cache and preserves the selected Node for service/login/status', async () => {
  const calls: string[] = []
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const installer = new SshInstaller('https://example.com/mikka', async () => 'synthetic-grant', state => {
    if (state.status === 'online' || state.status === 'failed') finish()
  }, async (_command, args) => {
    const script = args.at(-1)!
    calls.push(script)
    if (script.includes('MIKKA_NODE_BIN=')) return 'MIKKA_NODE_BIN=/opt/homebrew/opt/node@22/bin'
    if (script.includes('mikka daemon status')) return '{"server":"online","deviceId":"owned-device"}'
    return ''
  }, '/home/installer fixture', undefined, undefined, 'prod', { command: '/bin/sh', args: script => ['-c', script] }, async () => true)
  await installer.beginLocal('owner')
  await done
  assert.equal(installer.state()?.status, 'online')
  const install = calls.find(command => command.includes('npm install'))!
  assert.match(install, /--cache '\/home\/installer fixture\/\.mikka\/npm-cache'/)
  assert.match(install, /--prefix '\/home\/installer fixture\/\.mikka\/npm'/)
  for (const command of calls.slice(1)) assert.match(command, /export PATH=.*node@22\/bin/)
})

test('check failure is structured, writes a private full log, and never starts npm', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mikka-check-'))
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const calls: string[] = []
  const states: SshInstallState[] = []
  const installer = new SshInstaller('https://example.com/mikka', async () => { throw new Error('must not mint') }, state => {
    states.push(state)
    if (state.status === 'failed') finish()
  }, async (_command, args) => {
    calls.push(args.at(-1)!)
    throw new InstallProcessError('Node.js >=22 required', 'v18.20.8\n', 'Node.js >=22 required\n', 1)
  }, home)
  try {
    await installer.beginLocal()
    await done
    const failure = installer.state()!
    assert.equal(failure.step, 'check')
    assert.equal(failure.error?.cause, 'node_required')
    assert.equal(failure.error?.remedy, 'install_node_22')
    assert.match(failure.reason ?? '', /^Node\.js >=22 required/)
    assert.equal(calls.some(command => command.includes('npm install')), false)
    assert.ok(failure.error?.logPath)
    assert.match(await readFile(failure.error.logPath, 'utf8'), /v18\.20\.8/)
    assert.equal((await stat(failure.error.logPath)).mode & 0o777, 0o600)
    assert.ok(failure.reason?.includes('v18.20.8'), 'older desktops can expand the complete redacted diagnostic through reason')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('stdin registration credentials are redacted even when a failed child echoes them', async () => {
  const token = 'synthetic-private-registration-token'
  await assert.rejects(runProcess(process.execPath, ['-e', "process.stdin.on('data',s=>{process.stdout.write(s);process.stderr.write(s)});process.stdin.on('end',()=>process.exit(1))"], `${token}\n`), error => {
    assert.ok(error instanceof InstallProcessError)
    assert.equal(`${error.message}${error.stdout}${error.stderr}`.includes(token), false)
    return true
  })
})

test('discovery includes nvm, fnm, Volta and Homebrew instead of relying on interactive shell setup', () => {
  const script = nodeDiscoveryScript(22, '/home/test')
  for (const path of ['.nvm/versions/node/', '.local/share/fnm/node-versions/', '.volta/tools/image/node/', '/opt/homebrew/opt/node@']) assert.ok(script.includes(path))
  assert.ok(script.includes('>= 22'))
})
