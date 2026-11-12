import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

const host = JSON.parse(await readFile('/app/eve-host.json', 'utf8'))
const { publicKey } = generateKeyPairSync('ed25519')
const publicBytes = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
const child = spawn(process.execPath, ['/app/runtime/start.mjs'], {
  cwd: '/app', stdio: 'inherit', env: { ...process.env,
    MIKKA_EVE_HOST: 'cloudflare', MIKKA_EVE_WORKFLOW_WORLD: 'cloudflare', MIKKA_DEPLOYMENT_STAGE: 'preview',
    MIKKA_DEPLOYMENT_ID: host.releaseId, MIKKA_EVE_RELEASE_ID: host.releaseId, WORKFLOW_DEPLOYMENT_ID: host.releaseId,
    MIKKA_BUILD_REVISION: host.sourceSha, MIKKA_UI_OVERLAY_SHA: host.uiSha,
    BETTER_AUTH_URL: 'https://eve.example.test', BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    MIKKA_EVE_PUBLIC_ORIGIN: 'https://eve.example.test', MIKKA_EVE_WORLD_TOKEN: randomBytes(32).toString('hex'),
    MIKKA_WORKFLOW_QUEUE_PUBLIC_KEY: publicBytes.toString('base64'),
  },
})
const exited = once(child, 'exit')
try {
  const flow = 'http://127.0.0.1:8080/.well-known/workflow/v1/flow'
  const deadline = Date.now() + 90_000
  let response
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try { response = await fetch(flow, { method: 'POST', body: '{}' }); break }
    catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error
      await sleep(200)
    }
  }
  assert.equal(response?.status, 409, 'unsigned callback for an unknown deployment must reach the compiled Cloudflare World')
  const unsigned = await fetch(flow, { method: 'POST', headers: { 'x-mikka-eve-release': host.releaseId }, body: '{}' })
  assert.equal(unsigned.status, 403, 'matching deployment still requires a valid queue signature')
  console.log(JSON.stringify({ sourceSha: host.sourceSha, releaseId: host.releaseId,
    node: process.version, unknownRelease: response.status, unsigned: unsigned.status }))
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await exited
}
