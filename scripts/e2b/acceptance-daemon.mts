/** A real disposable personal device on the candidate image. Normal enrollment,
 * registration and the normal Cloud credential handoff all remain on.
 * The production resolver selects the image's actual official CLI. The gate
 * supplies no binary override. No credential enters stdout or argv. */
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hostname, platform, arch } from 'node:os'
import { DAEMON_PROTOCOL_VERSION } from '../../packages/protocol/src/index.ts'
import { holdCandidateRegistration, publishCandidateBootstrap, waitForCandidateStart } from './acceptance-bootstrap.mts'
import { registrationLogin } from '../../packages/daemon/src/login.ts'
import { HttpServerLink } from '../../packages/daemon/src/server-link-http.ts'
import { DAEMON_VERSION } from '../../packages/daemon/src/paths.ts'
import { probeHostedRuntimeModels } from '../../packages/daemon/src/cloud-model-probe.ts'
import { hostedBinaries, readHostedCliManifest } from '../../packages/daemon/src/hosted-binaries.ts'

async function main() {
  const origin = process.env.MIKKA_ACCEPTANCE_ORIGIN
  const harness = process.env.MIKKA_ACCEPTANCE_HARNESS
  const workspaceId = process.env.MIKKA_ACCEPTANCE_WORKSPACE_ID
  if (origin !== 'https://app.aspectlylabs.com' || (harness !== 'claude_code' && harness !== 'codex') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(workspaceId ?? '')) throw Error('candidate_configuration_invalid')
  const dataDir = '/home/user/.mikka/template-acceptance'
  await mkdir(dataDir, { mode: 0o700 })
  const manifest = readHostedCliManifest()
  const expectedKind = harness === 'claude_code' ? 'claude' : 'codex'
  const recorded = manifest?.original[harness]
  if (manifest?.kind !== expectedKind || !recorded) throw Error('candidate_official_cli_missing')
  const selected = hostedBinaries()[harness]
  if (!selected) throw Error('candidate_official_cli_missing')
  const binary = realpathSync(selected)
  const binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex')
  const original = JSON.parse(readFileSync('/opt/mikka/official-files-before.json', 'utf8')).entries
    .find((row: { path: string }) => row.path === binary)
  if (original?.kind !== 'file' || original.sha256 !== binarySha256
    || recorded.path !== binary || recorded.sha256 !== binarySha256) throw Error('candidate_official_cli_not_preserved')
  // Official images own their CLI versions. The managed local-install pin is
  // not their compatibility policy; execute the actual preserved binary.
  const measuredVersion = (await promisify(execFile)(binary, ['--version'], { timeout: 10000, maxBuffer: 16384 })).stdout.trim()
  const version = (harness === 'codex' ? /^codex-cli\s+(\d+\.\d+\.\d+)$/ : /^(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/).exec(measuredVersion)?.[1]
  if (!version) throw Error('candidate_cli_version_missing')
  // Use the same anonymous probe and in-memory handoff as the preloaded
  // production worker. Registration must already contain the real catalogue;
  // a later second probe must not hide an incomplete first registration.
  const probe = await probeHostedRuntimeModels()
  const catalogue = probe.reports.find(row => row.harness === harness)
  if (!catalogue?.installed || !catalogue.models?.length) throw Error('candidate_cli_models_missing')
  if (realpathSync(probe.binaries[harness] ?? '') !== binary
    || createHash('sha256').update(readFileSync(binary)).digest('hex') !== binarySha256) {
    throw Error('candidate_official_cli_not_preserved')
  }
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > 256) throw Error('candidate_enrollment_invalid')
  }
  const credential = await registrationLogin({ serverUrl: `${origin}/mikka`, token: input.trim() })
  input = ''
  const link = new HttpServerLink(`${origin}/mikka`, fetch, DAEMON_VERSION)
  // Register capabilities normally, but do not start a daemon that could claim
  // before the real queued run's bootstrap sidecars have been published.
  const registered = await link.registerDevice(credential, {
    name: hostname(), hostname: hostname(), platform: platform(), arch: arch(), deviceType: 'server',
    daemonVersion: DAEMON_VERSION, protocolVersion: DAEMON_PROTOCOL_VERSION, workspaceId: workspaceId!,
    harnesses: probe.reports.map(row => ({ ...row, subscriptionBroker: true as const, toolApproval: true as const,
      ...(row.harness === 'claude_code' ? { subscriptionModelCatalogue: true as const } : {}), coordinator: false })),
    computerUse: { installed: false, version: null },
  })
  // Personal devices are global; the requested team is bound by the owned
  // queued-run projection and checked again by the normal claim.
  const bootstrap = JSON.stringify({ deviceId: registered.deviceId, workspaceId, credential,
    server: `${origin}/mikka`, tracing: registered.tracing, collectCliTiming: true })
  const bootstrapSha256 = createHash('sha256').update(bootstrap).digest('hex')
  const proof = { deviceId: registered.deviceId, workspaceId, harness, binary, binarySha256, version,
    bootstrapSha256, registrationMode: 'cloud_worker_bootstrap' }
  await writeFile(`${dataDir}/device-proof.json`, `${JSON.stringify(proof)}\n`, { mode: 0o600, flag: 'wx' })
  const abort = new AbortController()
  const stop = () => abort.abort(Error('candidate_bootstrap_cancelled'))
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  let presence: Awaited<ReturnType<typeof holdCandidateRegistration>> | undefined
  try {
    presence = await holdCandidateRegistration(link, registered.deviceId, abort.signal)
    const start = waitForCandidateStart(dataDir + '/start.json', presence.signal)
    // The watcher and normal push presence exist before dispatch may begin.
    process.stdout.write('mikka-template-device ' + JSON.stringify(proof) + '\n')
    const projection = await start
    presence.signal.throwIfAborted()
    await presence.close()
    abort.signal.throwIfAborted()
    const pid = Number(readFileSync('/home/user/.mikka/preloaded.pid', 'utf8').trim())
    if (!Number.isSafeInteger(pid) || pid <= 1) throw Error('candidate_preloaded_worker_missing')
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    if (!command.includes('/opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js') || !command.includes('--wait-bootstrap'))
      throw Error('candidate_preloaded_worker_invalid')
    process.kill(pid, 0)
    const receipt = await publishCandidateBootstrap('/home/user/.mikka', bootstrap, projection, harness, abort.signal)
    process.kill(pid, 'SIGUSR1')
    await writeFile(`${dataDir}/bootstrap-proof.json`, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx' })
    process.stdout.write(`mikka-template-bootstrap ${JSON.stringify(receipt)}\n`)
  } finally { await presence?.close(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop) }

}

void main().catch(error => {
  const code = /^candidate_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'candidate_daemon_failed'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
