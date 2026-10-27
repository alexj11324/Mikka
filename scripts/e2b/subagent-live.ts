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
  await installSubagentRuntime(sandbox)
  const held: SubagentLease = { subagentId: randomUUID(), botId: randomUUID(), workspaceId: randomUUID(), ownerId: 'synthetic-owner', epoch: 1, controlledBy: 'synthetic-owner', controlUntil: Date.now() / 1000 + 120, computerAllowed: true, policyVersion: 1, stopRequested: false }
  await startSubagentBrowser(sandbox, held.subagentId)
  await syncSubagentLease(sandbox, held)
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
  await stopSubagentBrowser(sandbox, held.subagentId)
  console.log('live subagent browser: startup, access grant, wait, handback and stop passed')
} finally { await sandbox.kill() }

}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Live test failed"); process.exitCode = 1 })
