/** Disposable E2B browser, isolation and control test. No user data. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Sandbox } from 'e2b'
import { installComputerRuntime, installSubagentRuntime, startSubagentBrowser, subagentBrowserAction, subagentViewerGrant, syncSubagentLease, stopSubagentBrowser, type SubagentLease } from '../../lib/computer/e2b-provider'

async function main() {

const template = process.env.E2B_COMPUTER_TEMPLATE
if (!template || !process.env.E2B_API_KEY) throw new Error('Disposable E2B template and key are required')
const sandbox = await Sandbox.create(template, { apiKey: process.env.E2B_API_KEY, proxy: process.env.HTTPS_PROXY, timeoutMs: 240_000 })
try {
  await installComputerRuntime(sandbox)
  console.log('live subagent: base runtime ready')
  await installSubagentRuntime(sandbox)
  console.log('live subagent: isolated egress ready')
  await sandbox.commands.run('if curl --connect-timeout 2 -s http://127.0.0.1:6082/ >/dev/null; then exit 1; fi', { user: 'root', timeoutMs: 5000 })
  await sandbox.commands.run('[ "$(curl -s -o /dev/null -w "%{http_code}" --proxy http://127.0.0.1:6082 --noproxy "" http://127.0.0.1.nip.io/)" = 403 ]', { user: 'user', timeoutMs: 15_000 })
  const outsider = await Sandbox.create(template, { apiKey: process.env.E2B_API_KEY, proxy: process.env.HTTPS_PROXY, timeoutMs: 60_000 })
  try {
    const host = sandbox.getHost(6082)
    if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('Invalid sandbox host')
    await outsider.commands.run(`status=$(curl -s --max-time 8 -o /dev/null -w '%{http_code}' https://${host}/ || true); [ "$status" != 200 ] && [ "$status" != 403 ]`, { user: 'root', timeoutMs: 12_000 })
  } finally { await outsider.kill() }
  const held: SubagentLease = { subagentId: randomUUID(), botId: randomUUID(), workspaceId: randomUUID(), ownerId: 'synthetic-owner', epoch: 1, controlledBy: 'synthetic-owner', controlUntil: Date.now() / 1000 + 120, computerAllowed: true, policyVersion: 1, stopRequested: false }
  await startSubagentBrowser(sandbox, held.subagentId)
  await syncSubagentLease(sandbox, held)
  const peer = { ...held, subagentId: randomUUID(), botId: randomUUID(), controlledBy: null, controlUntil: 0 }
  await startSubagentBrowser(sandbox, peer.subagentId)
  await syncSubagentLease(sandbox, peer)
  const firstRequest = randomUUID(), secondRequest = randomUUID()
  await sandbox.files.write(`/home/user/.mikka/subagents/${held.subagentId}/request-${firstRequest}.json`, JSON.stringify({ action: 'setCookies', cookies: [{ name: 'mikka_fixture_342', value: 'synthetic', url: 'https://example.com/' }] }), { user: 'user' })
  await sandbox.files.write(`/home/user/.mikka/subagents/${peer.subagentId}/request-${secondRequest}.json`, JSON.stringify({ action: 'cookies' }), { user: 'user' })
  await sandbox.commands.run(`/usr/local/bin/node /opt/mikka/computer/subagent-rpc.mjs ${held.subagentId} ${firstRequest} >/dev/null; /usr/local/bin/node /opt/mikka/computer/subagent-rpc.mjs ${peer.subagentId} ${secondRequest} > /tmp/mikka-cookie-fixture.json; node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync("/tmp/mikka-cookie-fixture.json"));if(!r.cookies.some(c=>c.name==="mikka_fixture_342"&&c.value==="synthetic"))process.exit(1)'`, { user: 'user', timeoutMs: 30_000 })
  const extra: SubagentLease[] = []
  for (let i = 0; i < 4; i++) {
    const lease = { ...peer, subagentId: randomUUID(), botId: randomUUID() }
    await startSubagentBrowser(sandbox, lease.subagentId)
    await syncSubagentLease(sandbox, lease)
    extra.push(lease)
  }
  for (const lease of extra) assert.equal(typeof (await subagentBrowserAction(sandbox, lease, { action: 'snapshot' })).title, 'string')
  for (const lease of extra) await stopSubagentBrowser(sandbox, lease.subagentId)
  console.log('live subagent: six concurrent browsers passed')
  const grant = await subagentViewerGrant(sandbox, held, held.ownerId, 'view')
  assert.match(grant.url, /^wss:\/\//)
  let finished = false
  const waiting = subagentBrowserAction(sandbox, held, { action: 'snapshot' }).then(result => { finished = true; return result })
  await new Promise(resolve => setTimeout(resolve, 2000))
  assert.equal(finished, false)
  const released = { ...held, controlledBy: null, controlUntil: 0, epoch: 2 }
  await syncSubagentLease(sandbox, released)
  const result = await waiting
  assert.equal(typeof result.title, 'string')
  await subagentBrowserAction(sandbox, released, { action: 'navigate', url: 'https://example.com' })
  let loaded = false, page: { title: string; elements: { ref: number; targetDigest: string }[] } | undefined
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    page = await subagentBrowserAction(sandbox, released, { action: 'snapshot' })
    if (page?.title === 'Example Domain') { loaded = true; break }
  }
  assert.equal(loaded, true, 'the isolated browser must still reach a public HTTPS page')
  const element = page?.elements[0]
  assert.ok(element, 'the public fixture contains a link')
  await assert.rejects(subagentBrowserAction(sandbox, released, { action: 'click', ref: element.ref, targetDigest: '0'.repeat(64) }))
  await subagentBrowserAction(sandbox, released, { action: 'click', ref: element.ref, targetDigest: element.targetDigest })
  await stopSubagentBrowser(sandbox, peer.subagentId)
  await stopSubagentBrowser(sandbox, held.subagentId)
  console.log('live subagent browser: cookie sharing, access grant, wait, handback and stop passed')
} finally { await sandbox.kill() }

}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Live test failed"); process.exitCode = 1 })
