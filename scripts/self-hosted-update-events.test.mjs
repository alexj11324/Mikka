import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createReceiver, windowBounds, windowDelay } from './self-hosted-update-webhook.mjs'

const adapter = fileURLToPath(new URL('./self-hosted-release-mail.py', import.meta.url))
const defaultTag = 'v2.3.4'
const revision = 'a'.repeat(40)
const digest = 'sha256:' + 'b'.repeat(64)
const migrations = 'c'.repeat(64)
const releaseBody = '<!-- mikka-self-hosted-release-v2 sha=' + revision + ' digest=' + digest + ' migrations=' + migrations + ' protocol=0-1 -->'

async function startInstallation(t, policy, options = {}) {
  const independent = mkdtempSync(join(tmpdir(), 'mikka-event-install-'))
  t.after(() => rmSync(independent, { recursive: true, force: true }))
  const secret = randomBytes(32).toString('hex')
  const secretFile = join(independent, 'mail.key')
  writeFileSync(secretFile, secret + '\n', { mode: 0o600 })
  const pendingPath = join(independent, 'pending-release.json')
  const fetches = [], applied = []
  const config = {
    policy, secret, stateDir: independent,
    fetchRelease: async tag => {
      fetches.push(tag)
      return { tag, revision, image: 'ghcr.io/alexj11324/mikka@' + digest, migrations }
    },
    apply: async tag => { applied.push(tag) },
    ...options
  }
  let server, port
  async function start() {
    server = createReceiver(config)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    port = server.address().port
  }
  async function stop() {
    if (server.listening) await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()))
  }
  await start()
  t.after(stop)
  function deliverMail(tag = defaultTag, owner = 'alexj11324/Mikka', file = secretFile) {
    const raw = [
      'From: notifications@github.com', 'Subject: [' + owner + '] Mikka self-hosted ' + tag,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64', '',
      Buffer.from('View the release: https://github.com/' + owner + '/releases/tag/' + tag + '?source=email\n').toString('base64'), ''
    ].join('\r\n')
    const child = spawn('python3', [adapter, '--secret-file', file, '--port', String(port)], { stdio: ['pipe', 'ignore', 'pipe'] })
    child.stdin.end(raw)
    return once(child, 'close').then(([code]) => code)
  }
  async function webhook(tag, key = secret) {
    const payload = JSON.stringify({
      repository: { full_name: 'alexj11324/Mikka' }, action: 'published',
      release: { draft: false, prerelease: false, tag_name: tag, body: releaseBody }
    })
    return (await fetch('http://127.0.0.1:' + port + '/self-hosted-release', {
      method: 'POST', body: payload, headers: {
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', key).update(payload).digest('hex'),
        'x-github-event': 'release'
      }
    })).status
  }
  return {
    applied, fetches, deliverMail, webhook, stop, start, config,
    read: () => existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath, 'utf8')) : null
  }
}

test('manual ignores events; notify verifies a mail hint against upstream and records it once', async t => {
  const manual = await startInstallation(t, 'manual')
  const notify = await startInstallation(t, 'notify')
  assert.equal(await manual.deliverMail(), 0)
  assert.equal(manual.read(), null)
  assert.deepEqual(manual.fetches, [])
  assert.equal(await notify.webhook(defaultTag, 'wrong-key'), 401)
  assert.equal(notify.read(), null)
  assert.equal(await notify.deliverMail(defaultTag, 'someone/fork'), 0)
  assert.equal(await notify.deliverMail('v2.3.4-rc.1'), 0)
  assert.deepEqual(notify.fetches, [])
  assert.equal(await notify.deliverMail(), 0)
  assert.deepEqual(notify.fetches, [defaultTag])
  assert.deepEqual([notify.read().tag, notify.read().revision, notify.read().status], [defaultTag, revision, 'notified'])
  assert.equal(await notify.deliverMail(), 0)
  assert.equal(await notify.webhook(defaultTag), 204)
  assert.deepEqual(notify.fetches, [defaultTag])
  assert.deepEqual(notify.applied, [])
})

test('auto persists an outside-window release across restart and delivers it exactly once when the window opens', async t => {
  let clock = new Date('2026-01-06T23:59:45Z'), timer
  const install = await startInstallation(t, 'auto', {
    windowUTC: '00:00-01:00', now: () => clock,
    schedule(fn, delay) { timer = { fn, delay }; return timer },
    cancel() { timer = undefined }
  })
  assert.equal(await install.deliverMail(), 0)
  assert.equal(install.read().status, 'queued')
  assert.equal(timer.delay, 15_000)
  assert.deepEqual(install.applied, [])
  await install.stop()
  await install.start()
  assert.equal(timer.delay, 15_000)
  clock = new Date('2026-01-07T00:00:00Z')
  timer.fn()
  await nextTurn()
  assert.equal(install.read().status, 'processed')
  assert.equal(await install.deliverMail(), 0)
  assert.equal(await install.webhook(defaultTag), 204)
  assert.equal(await install.deliverMail('v1.0.0'), 0)
  assert.deepEqual(install.applied, [defaultTag])
  assert.deepEqual(install.fetches, [defaultTag])
})

test('multiple in-window releases serialize and an interrupted attempt is not repeated', async t => {
  const active = Promise.withResolvers()
  const applied = []
  const install = await startInstallation(t, 'auto', {
    apply: async tag => { applied.push(tag); if (tag === defaultTag) await active.promise }
  })
  assert.equal(await install.webhook(defaultTag), 202)
  assert.equal(await install.webhook(defaultTag), 204)
  assert.equal(await install.deliverMail('v2.3.5'), 0)
  assert.deepEqual(applied, [defaultTag])
  active.resolve()
  await nextTurn()
  assert.deepEqual(applied, [defaultTag, 'v2.3.5'])
  assert.equal(install.read().status, 'processed')
  install.config.apply = async () => { throw new Error('SELF_HOSTED_UPDATE_DRAIN_REQUIRED') }
  await install.stop()
  await install.start()
  assert.equal(await install.deliverMail('v2.3.6'), 0)
  assert.equal(install.read().reason, 'SELF_HOSTED_UPDATE_DRAIN_REQUIRED')
  await install.stop()
  await install.start()
  assert.equal(install.read().status, 'failed')
  assert.equal(await install.webhook('v2.3.6'), 204)
})

test('unverified mail hints remain undelivered for MTA retry', async t => {
  const install = await startInstallation(t, 'auto', { fetchRelease: async () => { throw new Error('release unavailable') } })
  assert.equal(await install.deliverMail(), 75)
  assert.equal(install.read(), null)
  assert.deepEqual(install.applied, [])
})

test('UTC windows cross midnight with an exclusive end and reject invalid configuration', () => {
  const overnight = windowBounds('23:00-01:00')
  for (const time of ['2026-01-07T23:00:00Z', '2026-01-08T00:59:59Z']) assert.equal(windowDelay(overnight, new Date(time)), 0)
  assert.equal(windowDelay(overnight, new Date('2026-01-08T01:00:00Z')), 22 * 3_600_000)
  for (const value of ['23:00-23:00', '24:00-01:00', '1-5']) assert.throws(() => windowBounds(value), /WINDOW_INVALID/)
})
