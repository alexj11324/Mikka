#!/usr/bin/env node
/** Opt-in host process. Each release wakes the controller once. A window
 * schedules a single local deadline; the controller never polls a registry. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { githubRelease } from './self-hosted-update.mjs'
import { compareStableTags, releaseFromWebhook, STABLE_TAG, verifySignature } from './self-hosted-update-policy.mjs'

const receiverPath = fileURLToPath(import.meta.url)

function windowBounds(value) {
  if (!value) return null
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) throw new Error('SELF_HOSTED_UPDATE_WINDOW_INVALID')
  const start = Number(match[1]) * 60 + Number(match[2])
  const end = Number(match[3]) * 60 + Number(match[4])
  if (start === end) throw new Error('SELF_HOSTED_UPDATE_WINDOW_INVALID')
  return { start, end }
}

function windowDelay(bounds, now) {
  if (!bounds) return 0
  const { start, end } = bounds
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes()
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end
  if (inside) return 0
  const next = new Date(now)
  next.setUTCHours(0, start, 0, 0)
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
  return next - now
}

function launchUpdater(tag) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./self-hosted-update.mjs', import.meta.url)), 'apply', tag, '--auto'], {
      cwd: process.cwd(), stdio: ['ignore', 'inherit', 'pipe']
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', part => { stderr = (stderr + part).slice(-4096) })
    child.once('error', cause => reject(new Error('SELF_HOSTED_UPDATE_AUTO_LAUNCH_FAILED', { cause })))
    child.once('close', code => {
      for (const line of stderr.trim().split(/\r?\n/)) {
        if (/^SELF_HOSTED_UPDATE_[A-Z0-9_]+$/.test(line)) console.error(line)
      }
      if (code === 0) return accept()
      const last = stderr.trim().split(/\r?\n/).at(-1)
      reject(new Error(/^SELF_HOSTED_UPDATE_[A-Z0-9_]+$/.test(last) ? last : 'SELF_HOSTED_UPDATE_AUTO_FAILED'))
    })
  })
}

export function createReceiver({
  secret, policy = 'notify', windowUTC, stateDir, fetchRelease = githubRelease,
  apply = launchUpdater, now = () => new Date(), schedule = setTimeout, cancel = clearTimeout
}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || !['manual', 'notify', 'auto'].includes(policy)) {
    throw new Error('SELF_HOSTED_UPDATE_WEBHOOK_CONFIG_INVALID')
  }
  const bounds = windowBounds(windowUTC)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const directory = lstatSync(stateDir)
  if (!directory.isDirectory() || (directory.mode & 0o077)) throw new Error('SELF_HOSTED_UPDATE_STATE_PERMISSIONS_INVALID')
  const pendingPath = join(stateDir, 'pending-release.json')
  let pending
  try { pending = JSON.parse(readFileSync(pendingPath, 'utf8')) } catch (cause) {
    if (cause.code !== 'ENOENT') throw new Error('SELF_HOSTED_UPDATE_PENDING_INVALID', { cause })
  }
  if (pending && (!STABLE_TAG.test(pending.tag) || !/^[a-f0-9]{40}$/.test(pending.revision))) {
    throw new Error('SELF_HOSTED_UPDATE_PENDING_INVALID')
  }
  function store(record) {
    const temporary = pendingPath + '.' + randomUUID() + '.tmp'
    writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx', flush: true })
    renameSync(temporary, pendingPath)
    pending = record
  }

  let timer, applying = false, closed = false
  function resume() {
    cancel(timer)
    if (closed || applying || pending?.status !== 'queued') return
    if (policy !== 'auto') {
      store({ ...pending, status: 'notified' })
      return
    }
    const delay = windowDelay(bounds, now())
    if (delay) {
      timer = schedule(resume, delay)
      return
    }
    const tag = pending.tag
    // Persist the attempt before invoking Docker. After a host crash the
    // operator inspects the updater lock/log instead of replaying mutations.
    store({ ...pending, status: 'applying' })
    applying = true
    Promise.resolve().then(() => apply(tag)).then(
      () => { if (pending.tag === tag) store({ ...pending, status: 'processed' }) },
      err => {
        const reason = /^SELF_HOSTED_UPDATE_[A-Z0-9_]+$/.test(err?.message) ? err.message : 'SELF_HOSTED_UPDATE_AUTO_FAILED'
        if (pending.tag === tag) store({ ...pending, status: 'failed', reason })
        console.error(reason, tag)
      }
    ).finally(() => {
      applying = false
      resume()
    })
  }

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !['/self-hosted-release', '/self-hosted-release-hint'].includes(req.url)) {
      res.writeHead(404).end()
      return
    }
    try {
      const chunks = []
      let length = 0
      for await (const chunk of req) {
        length += chunk.length
        if (length > 32 * 1024) { res.writeHead(413).end(); return }
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      if (!verifySignature(bytes, req.headers['x-hub-signature-256'], secret)) { res.writeHead(401).end(); return }
      let release
      if (req.url === '/self-hosted-release-hint') {
        // Message bodies can be forged. Only the fixed upstream API supplies
        // the release metadata and the updater independently reads it at apply.
        const tag = JSON.parse(bytes.toString('utf8')).tag
        if (typeof tag !== 'string' || tag.length > 64 || !STABLE_TAG.test(tag)) { res.writeHead(400).end(); return }
        if (policy === 'manual' || (pending && compareStableTags(tag, pending.tag) <= 0)) { res.writeHead(204).end(); return }
        try { release = await fetchRelease(tag) }
        catch {
          console.error('SELF_HOSTED_UPDATE_RELEASE_LOOKUP_FAILED', tag)
          res.writeHead(503).end('SELF_HOSTED_UPDATE_RELEASE_LOOKUP_FAILED\n')
          return
        }
      } else {
        release = releaseFromWebhook(bytes, req.headers, secret)
      }
      if (!release || policy === 'manual') { res.writeHead(204).end(); return }
      const order = pending ? compareStableTags(release.tag, pending.tag) : 1
      if (order === 0 && pending.revision !== release.revision) { res.writeHead(409).end(); return }
      if (order <= 0) { res.writeHead(204).end(); return }
      store({ tag: release.tag, revision: release.revision, receivedAt: now().toISOString(), status: policy === 'auto' ? 'queued' : 'notified' })
      console.log('SELF_HOSTED_UPDATE_RELEASE_AVAILABLE', release.tag)
      resume()
      res.writeHead(202).end()
    } catch (error) {
      if (error instanceof SyntaxError || error?.message?.startsWith('SELF_HOSTED_UPDATE_WEBHOOK_') ||
          error?.message?.startsWith('SELF_HOSTED_UPDATE_RELEASE_')) { res.writeHead(400).end(); return }
      console.error('SELF_HOSTED_UPDATE_RECEIVER_FAILED')
      res.writeHead(500).end()
    }
  })
  server.once('listening', resume)
  server.once('close', () => { closed = true; cancel(timer) })
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === receiverPath) {
  const port = Number(process.env.MIKKA_UPDATE_WEBHOOK_PORT || 37499)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SELF_HOSTED_UPDATE_WEBHOOK_CONFIG_INVALID')
  createReceiver({
    secret: process.env.MIKKA_UPDATE_WEBHOOK_SECRET,
    policy: process.env.MIKKA_UPDATE_POLICY || 'notify',
    windowUTC: process.env.MIKKA_UPDATE_WINDOW_UTC,
    stateDir: resolve(process.env.MIKKA_UPDATE_STATE_DIR || '.mikka-updates')
  }).listen(port, '127.0.0.1', () => console.log('SELF_HOSTED_UPDATE_WEBHOOK_READY'))
}

export { windowBounds, windowDelay }
