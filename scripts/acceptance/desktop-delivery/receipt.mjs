import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const base = process.argv[2]
const source = process.env.GITHUB_SHA
const overlay = process.env.EXPECTED_OVERLAY_SHA
const sha = /^[a-f0-9]{40}$/
assert.match(source, sha)
assert.match(overlay, sha)
async function optional(name) {
  try { return (await readFile(join(base, name), 'utf8')).trim() }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'EACCES') return null; throw error }
}
const proof = await optional('run/case/proof.json')
const report = proof ? JSON.parse(proof) : { success: false, checks: [] }
if (proof) {
  assert.equal(report.interface, 'packaged-electron')
  assert.equal(report.revision, source)
}
const expectedModel = 'SmolLM2-135M-Instruct-Q4_K_M'
const log = await optional('run/case/delivery.log')
const windowPhases = log?.split('\n').flatMap(line => {
  const match = /^Desktop delivery qualification: ([a-z-]{1,60})$/.exec(line)
  return match ? [match[1]] : []
}) ?? []
// Keep diagnostics from the worker's credential-bearing stderr to a fixed
// vocabulary. The raw journal, argv, certificates and endpoints stay private.
const daemon = await optional('run/case/daemon.log')
const workerErrors = !daemon ? null : [
  'EACCES', 'EPERM', 'ENOENT', 'ERR_MODULE_NOT_FOUND', 'ERR_INVALID_PACKAGE_CONFIG', 'ECONNREFUSED', 'EHOSTUNREACH',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
  'Device registration token expired or already used', 'Invalid registration token',
  'sudo: a password is required', 'Cannot find package', 'Cannot find module', 'fetch failed',
].filter(reason => daemon.includes(reason))
const result = {
  ...report, source, overlay, run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  driverRevision: await optional('driver.revision'), imageId: await optional('image.id'),
  stage: await optional('stage'), windowPhases, workerErrors, postgres: await optional('run/case/pg.version'),
  model: expectedModel, weightSha256: '2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d',
  paidSubscription: false,
}
const text = JSON.stringify(result, null, 2) + '\n'
if (/(?:mkg_|orv_)[a-z0-9_-]{25,}|BEGIN [A-Z ]*PRIVATE KEY|postgres(?:ql)?:\/\/|(?:bearer|set-cookie):|(?:session_token|sessionToken)=/i.test(text)) {
  throw new Error('UNSANITIZED_DESKTOP_DELIVERY_RECEIPT')
}
await writeFile(join(base, 'public-receipt.json'), text, { mode: 0o600 })
