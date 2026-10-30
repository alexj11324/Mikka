import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = mkdtempSync(join(tmpdir(), 'mikka-491-run-'))
const container = 'mikka-491-ci-ssh'
const run = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
try {
  const build = run(process.execPath, ['packages/daemon/scripts/build.mjs'])
  const directory = /Retained build directory: (.+)/.exec(build)?.[1]
  if (!directory) throw new Error('Missing daemon build artifact')
  const packed = JSON.parse(run('npm', ['pack', directory, '--json', '--pack-destination', fixture]))[0]
  run(process.execPath, ['apps/desktop/scripts/build.mjs'])
  run('docker', ['build', '-t', 'mikka-491-ssh-test', 'tests/ssh-install'], { stdio: 'inherit' })
  run('docker', ['run', '-d', '--rm', '--privileged', '--name', container, '--tmpfs', '/run', '--tmpfs', '/run/lock', '-p', '127.0.0.1:22491:22', 'mikka-491-ssh-test'])
  // systemd starts sshd asynchronously; wait for its actual readiness.
  run('docker', ['exec', container, 'sh', '-c', 'for i in $(seq 1 30); do systemctl is-active --quiet ssh && exit 0; sleep 1; done; exit 1'])
  run('docker', ['cp', join(fixture, packed.filename), `${container}:/tmp/mikka.tgz`])
  let installCommand
  if (process.env.MIKKA_SSH_TEST_NPM_CACHE) {
    run('docker', ['exec', container, 'mkdir', '-p', '/tmp/cache'])
    run('docker', ['cp', join(process.env.MIKKA_SSH_TEST_NPM_CACHE, '_cacache'), `${container}:/tmp/cache/_cacache`])
    installCommand = 'npm install --global --offline --cache /tmp/cache /tmp/mikka.tgz'
  }
  run(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--test', 'tests/ssh-install/e2e.test.ts'], {
    env: { ...process.env, MIKKA_SSH_TEST_CONTAINER: container, MIKKA_SSH_TEST_INSTALL_COMMAND: installCommand }, stdio: 'inherit',
  })
} finally {
  try { run('docker', ['stop', container]) } catch { /* fixture may not have started */ }
  rmSync(fixture, { recursive: true, force: true })
}
