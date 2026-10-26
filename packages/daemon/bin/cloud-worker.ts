// Invoked only by trusted E2B infrastructure as the dedicated runner user.
// The handoff path and data directory are fixed; no credential enters argv.
import { consumeCloudBootstrap, installCloudCredential } from '../src/cloud-bootstrap'
import { runCli } from '../src/cli'

const root = '/home/mikka-runner/.mikka'
async function main() {
  const config = consumeCloudBootstrap(`${root}/bootstrap.json`)
  const dataDir = `${root}/worker`
  if (await installCloudCredential(dataDir, config) === 'updated') return
  const code = await runCli(['daemon', '--data-dir', dataDir, '--server', config.server, '--hosted-subscriptions', '--e2b-container-runtime'])
  if (code !== null && code !== 0) throw new Error('Cloud worker failed')
}
void main().catch(() => { process.stderr.write('Cloud worker unavailable\n'); process.exitCode = 1 })
