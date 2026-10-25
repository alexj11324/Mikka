// Operator-only real staging CRUD probe. NOT run by ordinary tests or application startup.
// A current custody token must already be supplied privately by its authorized owner.
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { InfisicalCredentialVault } from '../lib/credentials/vault.ts'

const projectId = '89850d6a-f020-4936-863e-df77380dfe40'
const environment = 'staging', secretPath = '/credential-acceptance/mik79'
const origin = process.env.MIKKA_CREDENTIAL_VAULT_ORIGIN ?? 'https://us.infisical.com'
if (!['https://us.infisical.com', 'https://app.infisical.com'].includes(origin)) throw new Error('Only official US Infisical origin is permitted')
const operation = process.argv[2], manifestPath = process.argv[3] && resolve(process.argv[3])
if (!['crud', 'cleanup'].includes(operation) || !manifestPath || process.env.MIK79_ALLOW_STAGING_CRUD !== '1') {
  console.error('Not executed: explicit staging CRUD authorization flag, operation and private manifest path required.')
  process.exit(2)
}
if (!process.env.MIKKA_CREDENTIAL_VAULT_TOKEN) {
  console.error('Not executed: authorized custody token is absent. Do not copy it into chat, argv or agent configuration.')
  process.exit(2)
}
const httpEvidence = []
const vault = new InfisicalCredentialVault({ origin, projectId, environment, secretPath,
  accessToken: async () => process.env.MIKKA_CREDENTIAL_VAULT_TOKEN,
  fetch: async (url, init) => {
    const response = await fetch(url, init)
    httpEvidence.push({ method: init.method, status: response.status })
    return response
  } })
let manifest
if (operation === 'cleanup') {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.origin !== origin || manifest.projectId !== projectId || manifest.environment !== environment || manifest.secretPath !== secretPath ||
    !Array.isArray(manifest.entries) || manifest.entries.length > 4 || manifest.entries.some(e => !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(e.reference))) throw new Error('Recovery manifest scope invalid')
} else {
  manifest = { origin, projectId, environment, secretPath, createdAt: new Date().toISOString(),
    entries: Array.from({ length: 4 }, () => ({ reference: randomUUID(), attempted: false, verified: false, removed: false, absentVerified: false })) }
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 })
  // Never overwrite an earlier recovery manifest. No secret values are written here.
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
}
const persist = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
let failed = false
for (const entry of manifest.entries) {
  try {
    if (operation === 'crud') {
      const synthetic = randomBytes(32).toString('hex')
      entry.attempted = true; await persist() // Persist exact name before an ambiguous network write.
      await vault.put(entry.reference, synthetic)
      const actual = await vault.read(entry.reference)
      const a = Buffer.from(synthetic), b = Buffer.from(actual)
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Synthetic roundtrip failed')
      entry.verified = true; await persist()
    }
  } catch { failed = true }
  finally {
    // Exact-name, idempotent DELETE; no list, business reads, folder mutation or IAM.
    if (entry.attempted) {
      entry.removed = false
      for (let attempt = 0; attempt < 3 && !entry.removed; attempt++) {
        try { await vault.remove(entry.reference); entry.removed = true }
        catch { if ([401, 403].includes(httpEvidence.at(-1)?.status)) break }
      }
      entry.absentVerified = false
      if (entry.removed) {
        const before = httpEvidence.length
        try { await vault.read(entry.reference) } catch {}
        entry.absentVerified = httpEvidence.length === before + 1 && httpEvidence.at(-1).status === 404
      }
      await persist()
      if (!entry.removed || !entry.absentVerified) failed = true
    }
  }
  if (failed && operation === 'crud') break
}
console.log(JSON.stringify({ operation, projectId, environment, secretPath,
  createdAttempts: manifest.entries.filter(e => e.attempted).length,
  verified: manifest.entries.filter(e => e.verified).length,
  cleanupPending: manifest.entries.filter(e => e.attempted && (!e.removed || !e.absentVerified)).length,
  manifestPath, httpEvidence, status: failed ? 'failed_or_cleanup_pending' : 'passed',
  scope: 'provider CRUD only; does not establish system/UI/login acceptance' }))
process.exitCode = failed ? 1 : 0
