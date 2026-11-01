import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** Prepare the daemon's own pinned, integrity-checked binaries before dispatch. */
export async function prepareLocalHarnesses({ root, dataDir, daemonUser, env, onChild = () => {}, log = () => {} }) {
  const started = Date.now()
  const cli = join(root, 'packages/daemon/harness/cli.mjs')
  log('setup: preparing pinned Claude Code and Codex')
  await Promise.all(['claude_code', 'codex'].map(harness => new Promise((resolve, reject) => {
    const args = [cli, join(dataDir, 'harness'), harness]
    const child = spawn(daemonUser ? 'setpriv' : process.execPath, daemonUser
      ? ['--reuid', daemonUser, '--regid', daemonUser, '--init-groups', process.execPath, ...args] : args,
    { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })
    onChild(child)
    child.once('error', () => reject(new Error(`Pinned ${harness} setup could not start`)))
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Pinned ${harness} setup exited with code ${code}`)))
  })))
  log(`setup: pinned harnesses ready in ${Date.now() - started}ms`)
}
