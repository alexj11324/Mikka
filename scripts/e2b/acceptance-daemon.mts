/** A real disposable personal device on the candidate image. Normal enrollment,
 * registration and the normal Cloud credential handoff all remain on.
 * The production resolver selects the image's actual official CLI. The gate
 * supplies no binary override. No credential enters stdout or argv. */
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startDaemon } from '../../packages/daemon/src/main.ts'
import { registrationLogin } from '../../packages/daemon/src/login.ts'
import { HttpServerLink } from '../../packages/daemon/src/server-link-http.ts'
import { DAEMON_VERSION } from '../../packages/daemon/src/paths.ts'
import { probeHarnessModels } from '../../packages/daemon/src/model-probe.ts'
import { hostedBinaries, readHostedCliManifest } from '../../packages/daemon/src/hosted-binaries.ts'

async function main() {
  const origin = process.env.MIKKA_ACCEPTANCE_ORIGIN
  const harness = process.env.MIKKA_ACCEPTANCE_HARNESS
  if (origin !== 'https://app.aspectlylabs.com' || (harness !== 'claude_code' && harness !== 'codex')) throw Error('candidate_configuration_invalid')
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
  const catalogue = await probeHarnessModels(harness, binary, { scratchDir: dataDir })
  if (!catalogue) throw Error('candidate_cli_models_missing')
  const measured: NonNullable<Parameters<typeof startDaemon>[0]['harnesses']> = [
    { harness, installed: true, version, ...catalogue },
  ]
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > 256) throw Error('candidate_enrollment_invalid')
  }
  const credential = await registrationLogin({ serverUrl: `${origin}/mikka`, token: input.trim() })
  input = ''
  const link = new HttpServerLink(`${origin}/mikka`, fetch, DAEMON_VERSION)
  const register = link.registerDevice.bind(link)
  let announced = false
  link.registerDevice = async (...args) => {
    const registered = await register(...args)
    if (!announced) {
      announced = true
      const proof = { deviceId: registered.deviceId, harness, binary, binarySha256, version }
      await writeFile(`${dataDir}/device-proof.json`, `${JSON.stringify(proof)}\n`, { mode: 0o600, flag: 'wx' })
      process.stdout.write(`mikka-template-device ${JSON.stringify(proof)}\n`)
    }
    return registered
  }
  const daemon = await startDaemon({ dataDir, flavor: 'prod', link, credential, hostedSubscriptions: true,
    harnesses: measured, modelProbe: true })
  const stop = () => { void daemon.stop().then(() => process.exit(0)) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

void main().catch(error => {
  const code = /^candidate_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'candidate_daemon_failed'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
