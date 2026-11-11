#!/usr/bin/env node
/** Optional host-side GitHub release webhook receiver.
 * Operator must have an authenticated upstream event delivery mechanism.
 * Binds loopback; terminate TLS at a reverse proxy. No registry polling. */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { releaseFromWebhook } from './self-hosted-update-policy.mjs'

const secret = process.env.MIKKA_UPDATE_WEBHOOK_SECRET
const policy = process.env.MIKKA_UPDATE_POLICY || 'notify'
const port = Number(process.env.MIKKA_UPDATE_WEBHOOK_PORT || 37499)
const stateDir = resolve(process.env.MIKKA_UPDATE_STATE_DIR || '.mikka-updates')
if (!secret || Buffer.byteLength(secret) < 32 || !['manual', 'notify', 'auto'].includes(policy) ||
  !Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('SELF_HOSTED_UPDATE_WEBHOOK_CONFIG_INVALID')
  process.exit(1)
}
mkdirSync(stateDir, { recursive: true, mode: 0o700 })

function notify(release) {
  const path = join(stateDir, 'pending-release.json')
  const tmp = path + '.' + randomUUID() + '.tmp'
  writeFileSync(tmp, JSON.stringify({ tag: release.tag, revision: release.revision, receivedAt: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(tmp, path)
}
function attempt(release) {
  const child = spawn(process.execPath, [resolve('scripts/self-hosted-update.mjs'), 'apply', release.tag, '--auto'], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe']
  })
  for (const output of [child.stdout, child.stderr]) output.on('data', chunk => {
    // Updater emits bounded product codes / release IDs, not raw Docker errors or secrets.
    process.stderr.write(chunk.toString().slice(0, 512))
  })
  child.on('error', () => console.error('SELF_HOSTED_UPDATE_AUTO_LAUNCH_FAILED'))
}
createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/self-hosted-release') {
    res.writeHead(404).end()
    return
  }
  let bytes = Buffer.alloc(0)
  try {
    for await (const chunk of req) {
      if (bytes.length + chunk.length > 32 * 1024) throw new Error('limit')
      bytes = Buffer.concat([bytes, chunk])
    }
    const release = releaseFromWebhook(bytes, req.headers, secret)
    if (!release) {
      res.writeHead(204).end()
      return
    }
    notify(release)
    if (policy === 'auto') attempt(release)
    res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":true}\n')
  } catch {
    res.writeHead(401).end('SELF_HOSTED_UPDATE_WEBHOOK_REJECTED\n')
  }
}).listen(port, '127.0.0.1', () => console.log('SELF_HOSTED_UPDATE_WEBHOOK_READY'))
