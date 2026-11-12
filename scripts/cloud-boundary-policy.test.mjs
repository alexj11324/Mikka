import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { auditCloudBoundary, auditCloudRepository, cloudBoundaryAllowlist, cloudBoundaryPolicyFiles, findCloudBoundary, staleCloudBoundaryEntries } from './cloud-boundary-policy.mjs'

const rules = (source, file = 'lib/accidental-service.ts') => findCloudBoundary(file, source).map(finding => finding.rule)
const policy = fileURLToPath(new URL('./cloud-boundary-policy.mjs', import.meta.url))
const expoURL = 'https://exp.host/--/api/v2/push'
const sendURL = `${expoURL}/send`
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mikka-cloud-boundary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q'], { cwd: root })
  const write = (file, source) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source) }
  return { root, write }
}

test('the existing public repository passes without moving core, billing, credentials or plugins', () => {
  assert.deepEqual(auditCloudRepository(), { findings: [], stale: [] })
})

for (const [label, source, rule] of [
  ['cloud issuer environment', 'const key = process.env.MIKKA_CLOUD_SIGNING_KEY', 'cloud/private-environment'],
  ['computed environment access', "const key = process.env['MIKKA_CLOUD_JWKS_PRIVATE_KEY']", 'cloud/private-environment'],
  ['constant-folded environment access', "const key = process.env['MIKKA_CLOUD_' + 'SIGNING_KEY']", 'cloud/private-environment'],
  ['cloud data-encryption credential', 'const key = env.MIKKA_CLOUD_DATA_KEY', 'cloud/private-environment'],
  ['private JWK material', "const key = { kty: 'EC', crv: 'P-256', d: material, x, y }", 'cloud/private-jwk'],
  ['aliased cloud signing primitive', "import { sign as issue } from 'node:crypto'; const aud='mikka-cloud'; issue('sha256', body, key)", 'cloud/token-issuer'],
  ['cloud JWT construction', "import { SignJWT as Token } from 'jose'; new Token({ aud: 'mikka-cloud' }).sign(key)", 'cloud/token-issuer'],
  ['private signing schema', "await db.query('SELECT private_ciphertext FROM cloud.signing_keys')", 'cloud/private-schema'],
  ['private schema under a renamed source path', "const schema = pgSchema('cloud')", 'cloud/private-schema'],
  ['GitHub token exchange endpoint', 'fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, { method: "POST" })', 'cloud/github-token-mint'],
  ['GitHub SDK token mint', 'octokit.apps.createInstallationAccessToken({ installation_id })', 'cloud/github-token-mint'],
  ['forwarded webhook signature header', "fetch(destination, { headers: { 'Mikka-Cloud-Signature': signature }, body })", 'cloud/github-webhook-forward'],
  ['Headers signature mutation', "headers.set('Mikka-Cloud-Signature', signature)", 'cloud/github-webhook-forward'],
  ['new Expo sender', `fetch('${sendURL}', { method: 'POST', body })`, 'cloud/privileged-expo-delivery'],
  ['new Expo base endpoint', `const endpoint = '${expoURL}'`, 'cloud/privileged-expo-delivery'],
  ['new Expo receipt reader', `fetch('${expoURL}/getReceipts', { method: 'POST', body })`, 'cloud/privileged-expo-delivery'],
  ['new Expo SDK sender', 'expo.sendPushNotificationsAsync(messages)', 'cloud/privileged-expo-delivery'],
  ['server-keyed usage outside the private schema', "db.query('INSERT INTO server_usage (server_id, amount) VALUES ($1,$2)')", 'cloud/cross-server-meter'],
  ['private metering schema', "db.query('INSERT INTO cloud.model_sessions (server_id, reservation_id) VALUES ($1,$2)')", 'cloud/private-schema'],
  ['registered cloud push endpoint', "router.post('/v1/push', relay)", 'cloud/service-route'],
  ['route-table model endpoint', "const route={method:'POST',path:'/v1/models/sessions',handle: request => execute(request)}", 'cloud/service-route'],
  ['request path dispatch', "if (url.pathname === '/v1/github/installation-token') return issue(request)", 'cloud/service-route'],
  ['cloud OAuth issuer handler', "const aud='mikka-cloud'; if(path === '/oauth/token') return issue(request)", 'cloud/service-route'],
  ['private package import', "import { service } from 'mikka-cloud/service'", 'cloud/private-package'],
  ['dynamic private package import', "const service = await import('@mikka/cloud-server')", 'cloud/private-package'],
]) test(`rejects ${label}`, () => assert.ok(rules(source).includes(rule), `${label}: ${rules(source)}`))

test('DDL and quoted cloud schemas are guarded without parsing SQL as JavaScript', () => {
  assert.ok(rules('CREATE TABLE "cloud"."usage_events" (server_id uuid, amount bigint);', 'drizzle/new.sql').includes('cloud/private-schema'))
  assert.ok(rules('CREATE SCHEMA IF NOT EXISTS cloud;', 'drizzle/new.sql').includes('cloud/private-schema'))
  assert.ok(rules('CREATE TABLE server_billing (server_id uuid, amount bigint);', 'migrations/new.sql').includes('cloud/cross-server-meter'))
})

test('file routes and vendored private service source cannot bypass primitive detection', () => {
  assert.ok(rules('export const POST = handle', 'app/v1/push/route.ts').includes('cloud/service-route'))
  assert.ok(rules('export const server = createServer()', 'services/mikka-cloud/src/index.ts').includes('cloud/private-service-tree'))
})

test('private service dependencies cannot move into a public build through a package manifest', () => {
  for (const pkg of [
    { name: 'mikka-cloud' },
    { dependencies: { '@mikka/cloud-server': '1.0.0' } },
    { dependencies: { renamed: 'git+https://github.com/alexj11324/mikka-cloud.git#main' } },
  ]) assert.ok(rules(JSON.stringify(pkg), 'package.json').includes('cloud/private-package'))
})

for (const [label, source] of [
  ['public cloud client', "cloudRequest(userId, 'push', '/v1/push', { method: 'POST', body })"],
  ['public receipts client', "cloudRequest(userId, 'push', '/v1/push/receipts', { method: 'POST', body })"],
  ['protocol path type', "type CloudPath = '/v1/push' | '/v1/github/installation-token' | '/oauth/token'"],
  ['JWKS verification', "import { jwtVerify, createRemoteJWKSet } from 'jose'; jwtVerify(token, createRemoteJWKSet(url), { audience: 'mikka-cloud' })"],
  ['public JWK material', "const jwk = { kty: 'EC', crv: 'P-256', x, y }"],
  ['stripping a private JWK field', 'const jwk = { ...candidate, kty, d: undefined }'],
  ['webhook verification', "const signature = request.headers.get('Mikka-Cloud-Signature'); verify(body, signature, ownRegistrationSecret)"],
  ['own GitHub App signing', "import { createSign } from 'node:crypto'; createSign('RSA-SHA256').update(claims).sign(config.pem)"],
  ['own-installation billing', "db.query('INSERT INTO billing_charges (workspace_id, amount) VALUES ($1,$2)')"],
  ['public cloud connection state', "db.query('INSERT INTO cloud_service_bindings (server_id, owner, secret) VALUES ($1,$2,$3)')"],
  ['public protocol dependency', "import type { CloudToken } from '@mikka/cloud-protocol'"],
  ['explanatory comment', '// process.env.MIKKA_CLOUD_SIGNING_KEY belongs in the private service'],
]) test(`allows ${label}`, () => assert.deepEqual(rules(source), [], label))

test('an existing Expo exception permits exactly one retained primitive, with no whole-file exemption', () => {
  const file = 'lib/mobile-push-delivery.ts'
  const original = `const endpoint='${expoURL}'`
  assert.deepEqual(auditCloudBoundary(file, original), [])
  assert.ok(auditCloudBoundary('lib/new-push.ts', original).length)
  assert.equal(auditCloudBoundary(file, `${original}; const duplicate='${expoURL}'`).length, 2)
  assert.equal(auditCloudBoundary(file, `${original}; fetch('${sendURL}')`).length, 1)
  assert.ok(auditCloudBoundary(file, `${original}; const secret=env.MIKKA_CLOUD_SIGNING_KEY`).some(finding => finding.rule === 'cloud/private-environment'))
})

test('the build source exception binds the exact signer and installation endpoint to its helper', () => {
  const file = 'scripts/private-source-auth.mjs'
  const source = readFileSync(new URL('./private-source-auth.mjs', import.meta.url), 'utf8')
  assert.deepEqual(auditCloudBoundary(file, source), [])
  assert.ok(auditCloudBoundary('scripts/another-source-auth.mjs', source).length)
  assert.ok(auditCloudBoundary(file, `${source}\ncreateSign('RSA-SHA256')`).some(finding => finding.rule === 'cloud/token-issuer'))
  assert.ok(auditCloudBoundary(file, `${source}\nconst secret=env.MIKKA_CLOUD_SIGNING_KEY`).some(finding => finding.rule === 'cloud/private-environment'))
})

test('every exception has a reason, one exact fingerprint and a positive hit count', () => {
  for (const [file, entries] of Object.entries(cloudBoundaryAllowlist)) for (const entry of entries) {
    assert.ok(entry.reason.length >= 20, file)
    assert.match(entry.fingerprint, /^[a-f0-9]{64}$/)
    assert.ok(Number.isInteger(entry.hits) && entry.hits > 0, file)
    assert.equal(file.includes('*'), false)
  }
  assert.deepEqual(staleCloudBoundaryEntries(), [])
})

test('removed or changed retained code requires removing its stale exception', t => {
  const f = fixture(t)
  const file = 'lib/mobile-push-delivery.ts', allowlist = { [file]: cloudBoundaryAllowlist[file] }
  assert.match(staleCloudBoundaryEntries(f.root, allowlist)[0], /no longer exists/)
  f.write(file, 'export const enabled = true')
  assert.match(staleCloudBoundaryEntries(f.root, allowlist)[0], /stale cloud boundary exception/)
})

test('the CI command fails on an added untracked violation and passes again after removal', t => {
  const f = fixture(t)
  // Reproduce only the retained primitives, never copy any private service code.
  f.write('lib/mobile-push-delivery.ts', `const endpoint='${expoURL}'`)
  f.write('scripts/dev-local/services.mjs', "if (path === '/v1/decisions') return localDecision()")
  f.write('scripts/private-source-auth.mjs', readFileSync(new URL('./private-source-auth.mjs', import.meta.url), 'utf8'))
  f.write('docs/contract.md', 'MIKKA_CLOUD_SIGNING_KEY is not a public setting')
  f.write('tests/private.fixture.ts', 'const secret=env.MIKKA_CLOUD_SIGNING_KEY')
  const run = () => spawnSync(process.execPath, [policy], { cwd: f.root, encoding: 'utf8' })
  assert.equal(run().status, 0)
  const violation = 'new-runtime/issuer.mts'
  f.write(violation, 'export const key = process.env.MIKKA_CLOUD_SIGNING_KEY')
  assert.ok(cloudBoundaryPolicyFiles(f.root).includes(violation), 'new directories and untracked source are scanned')
  const rejected = run()
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /new-runtime\/issuer\.mts:1:\d+ cloud\/private-environment/)
  rmSync(join(f.root, violation))
  assert.equal(run().status, 0)
})

test('the same policy command is a local check and a required source CI step', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts['check:cloud-boundary'], 'node scripts/cloud-boundary-policy.mjs && node --test scripts/cloud-boundary-policy.test.mjs')
  assert.ok(pkg.scripts.check.split(' && ').includes('pnpm check:cloud-boundary'))
  const workflow = readFileSync(new URL('../.github/workflows/ui-policy.yml', import.meta.url), 'utf8')
  const sourceChecks = workflow.slice(workflow.indexOf('\n  source-checks:'), workflow.indexOf('\n  daemon-checks:'))
  assert.match(sourceChecks, /run: pnpm check:cloud-boundary/)
})
