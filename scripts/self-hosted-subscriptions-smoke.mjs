// Runs in the actual standalone image. This checks binary packaging/startup,
// not OAuth, subscription availability or an official provider model call.
import { spawnSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { accessSync, constants, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function check(condition, code) {
  if (!condition) throw new Error(code)
}

const root = process.cwd()
const manifest = JSON.parse(readFileSync(join(root, 'mikka-build.json'), 'utf8'))
check(manifest.preset === 'node-server' && Array.isArray(manifest.resources), 'SUBSCRIPTION_BUILD_MANIFEST_INVALID')
// The standalone image can start a user's official E2B computer without any
// platform environment. Its public runtime pins must describe this build;
// no E2B key, subscription identity or task credential belongs in the image.
check(/^[a-f0-9]{40}$/.test(manifest.revision)
  && process.env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT === manifest.revision
  && /^[a-f0-9]{40}$/.test(process.env.MIKKA_CLOUD_WORKER_SHA ?? ''), 'STANDALONE_WORKER_RELEASE_MISSING')
const pin = readFileSync(join(root, 'packages/subscription-worker/CPA_COMMIT'), 'utf8').trim()
check(/^[a-f0-9]{40}$/.test(pin), 'SUBSCRIPTION_CPA_PIN_INVALID')
// Go uses the Debian system trust bundle; Node's own bundled roots do not
// establish that the separately executed subscription binaries can use TLS.
const certificates = readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8')
  .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
check(certificates.length > 0, 'SUBSCRIPTION_SYSTEM_CA_EMPTY')
for (const certificate of certificates) new X509Certificate(certificate)

const results = []
for (const [name, errorCode] of [
  ['mikka-subscription-worker', 'subscription_worker_unavailable'],
  ['mikka-subscription-enrollment', 'subscription_enrollment_unavailable'],
]) {
  const path = `packages/subscription-worker/bin/${name}`
  const binary = join(root, path)
  check(lstatSync(binary).isFile(), 'SUBSCRIPTION_BINARY_MISSING')
  accessSync(binary, constants.X_OK)
  const bytes = readFileSync(binary)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const resource = manifest.resources.find(item => item.path === path)
  check(resource?.sha256 === sha256 && resource.bytes === bytes.length, 'SUBSCRIPTION_BINARY_MANIFEST_MISMATCH')
  // No inherited environment, database connection, credential or remote
  // endpoint enters these children. An empty config fails before any I/O.
  const options = { cwd: root, env: { LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 5_000, maxBuffer: 4_096 }
  if (name === 'mikka-subscription-worker') {
    const version = spawnSync(binary, ['--version'], options)
    check(!version.error && version.status === 0 && version.stdout === `${name} CPA ${pin}\n`
      && version.stderr === '', 'SUBSCRIPTION_BINARY_VERSION_INVALID')
  }
  const refused = spawnSync(binary, [], { ...options, input: '{}\n' })
  check(!refused.error && refused.status === 1 && refused.stdout === '' && refused.stderr === `${errorCode}\n`,
    'SUBSCRIPTION_BINARY_CONFIG_NOT_REFUSED')
  results.push({ name, sha256, executable: true, missingConfigurationRefused: true })
}
console.log(JSON.stringify({ phase: 'subscription_binary_startup', revision: manifest.revision, cpaCommit: pin, systemCaCertificates: certificates.length,
  binaries: results, providerRequests: 0, subscriptionAcceptance: false }))
