// Read-only acceptance driver. Endpoint paths come from the reviewed integration
// manifest; this candidate deliberately does not invent or publish these routes.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

if (process.argv.length !== 5 || process.argv[2] !== '--execute-readonly') {
  console.log('Usage: node scripts/verify-operation-acceptance.mjs --execute-readonly /private/manifest.json /private/browser-storage-state.json')
  console.log('Requires parent-approved frozen deployment and existing authorized browser session. Sends GET only; never triggers an operation.')
  process.exit(process.argv.includes('--help') ? 0 : 2)
}
let context
try {
  const manifest = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'))
  const origin = new URL(manifest.deploymentUrl)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('invalid deployment origin')
  if (!/^[a-f0-9]{40}$/.test(manifest.expectedSha)) throw new Error('exact SHA required')
  for (const key of ['operationId', 'ownerId', 'workspaceId', 'providerObjectId']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) throw new Error('expected binding required')
  }
  const endpoint = path => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('relative path required')
    const url = new URL(path, origin)
    if (url.origin !== origin.origin || url.search || url.hash) throw new Error('same-origin path without secrets required')
    return url.toString()
  }
  const urls = [manifest.versionPath, manifest.operationPath, manifest.providerReadbackPath].map(endpoint)
  const { request } = await import('@playwright/test')
  context = await request.newContext({ storageState: resolve(process.argv[4]), ignoreHTTPSErrors: false })
  const read = async url => {
    const response = await context.get(url, { maxRedirects: 0, timeout: 15000 })
    if (response.status() !== 200) throw new Error('readback request did not return 200')
    return response.json()
  }
  const version = await read(urls[0])
  if (version.sha !== manifest.expectedSha) throw new Error('deployment version mismatch')
  const operation = await read(urls[1])
  if (operation.operationId !== manifest.operationId || operation.ownerId !== manifest.ownerId || operation.workspaceId !== manifest.workspaceId || operation.status !== 'succeeded' || operation.receipt?.providerObjectId !== manifest.providerObjectId) throw new Error('operation binding or result mismatch')
  // This route MUST perform independent remote lookup through the reviewed adapter,
  // not return the ledger receipt. Audit that implementation before using this driver.
  const remote = await read(urls[2])
  if (remote.source !== 'provider' || remote.providerObjectId !== manifest.providerObjectId || remote.idempotencyKey !== operation.idempotencyKey) throw new Error('independent provider readback mismatch')
  if ((await read(urls[0])).sha !== manifest.expectedSha) throw new Error('deployment changed during acceptance')
  // Never print session data, target/account IDs, URLs, provider responses or traces.
  console.log(JSON.stringify({ status: 'passed', check: 'read-only-operation-readback', sha: manifest.expectedSha, utc: new Date().toISOString() }))
} catch {
  console.error('Operation readback acceptance failed or prerequisites missing. Inspect privately; do not publish raw response/session data.')
  process.exitCode = 1
} finally {
  await context?.dispose()
}
