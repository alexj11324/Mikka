// Invoked only by trusted E2B infrastructure, as the template's default user
// (decision 2026-11-01-2335). The handoff path and data directory are fixed;
// no credential enters argv.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { consumeCloudBootstrap, installCloudCredential, watchCloudBootstraps } from '../src/cloud-bootstrap'
import { runCli } from '../src/cli'

const root = '/home/user/.mikka'
async function accept() {
  const config = consumeCloudBootstrap(`${root}/bootstrap.json`)
  const dataDir = `${root}/worker`
  if (await installCloudCredential(dataDir, config) === 'updated') return
  // Only the desktop template carries a desktop and its driver; a task machine
  // (E2B's claude or codex template) has neither.
  const computer = existsSync('/opt/mikka/computer/cua-driver') ? ['--e2b-computer'] : []
  const code = await runCli(['daemon', '--data-dir', dataDir, '--server', config.server, '--hosted-subscriptions', '--e2b-container-runtime', ...computer], undefined, { protectionBypass: config.protectionBypass })
  if (code !== null && code !== 0) throw new Error('Cloud worker failed')
}
const failed = () => { process.stderr.write('Cloud worker unavailable\n'); process.exit(1) }
if (process.argv.includes('--wait-bootstrap')) {
  // The template snapshot contains imported software and an idle watcher,
  // never a device identity, provider key or viewer signing key.
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const close = watchCloudBootstraps(root, accept, failed)
  const ready = `${root}/preloaded.pid`
  writeFileSync(ready, `${process.pid}\n`, { mode: 0o600 })
  process.once('exit', () => { close(); try { unlinkSync(ready) } catch {} })
} else {
  void accept().catch(failed)
}
