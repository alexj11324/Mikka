// One fixed synthetic scenario. Importing this module cannot start a server/browser.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, access } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { prepareAcceptanceLifecycle } from '../../lib/credentials/acceptance-lifecycle'
import { OwnedChromiumExecutor } from '../../lib/credentials/owned-chromium'
import { assertScenario } from './credential-admission.mjs'
import type { Binding } from '../../lib/credentials/contracts'

const entry = fileURLToPath(import.meta.url)
const scenarioFile = new URL('./credential-positive-scenario.json', import.meta.url)
export async function positiveCycle(executor: Pick<OwnedChromiumExecutor, 'open' | 'execute' | 'end' | 'state' | 'readDOM'>, binding: Binding, scenario: { serviceId: string; syntheticPassword: string }) {
  await executor.open(binding)
  await assert.rejects(executor.readDOM({ ...binding, ownerId: randomUUID() }), { code: 'browser_session_not_found' })
  const result = await executor.execute(binding, scenario.serviceId, {
    requestId: randomUUID(), sessionDeadline: Date.now() + 60000,
    resolveAndAdmit: async () => scenario.syntheticPassword, stillAuthorized: async () => true,
  })
  assert.equal(result.phase, 'restored')
  assert.deepEqual(executor.state(binding), { phase: 'restored', fenced: false })
  await executor.end(binding)
  assert.throws(() => executor.state(binding), { code: 'browser_session_not_found' })
}

export async function preparePositiveRunner() {
  const scenario = JSON.parse(await readFile(scenarioFile, 'utf8'))
  const binding = Object.fromEntries(['ownerId', 'workspaceId', 'taskId', 'runId', 'executionSession', 'authSessionId'].map(key => [key, randomUUID()])) as Binding
  const prepared = await prepareAcceptanceLifecycle('/tmp', binding)
  // Keep this host alive for explicit resume; neither approval nor a browser is created.
  return { scenario, binding, prepared }
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--prepare'], 'only explicit --prepare supported')
  assertScenario({ kind: 'executor-positive-once', runner: entry, scenario: JSON.parse(await readFile(scenarioFile, 'utf8')) },
    (await readFile('/proc/self/cmdline', 'utf8')).split('\0').filter(Boolean), process.env, realpathSync(process.cwd()))
  const { scenario, binding, prepared } = await preparePositiveRunner()
  console.log(JSON.stringify({ state: 'prepared-awaiting-exact-approval', root: prepared.root, manifestHash: prepared.manifestHash }))
  const input = createInterface({ input: process.stdin })
  const [line] = await once(input, 'line'); input.close()
  assert.equal(line, 'resume-once', 'no execution requested')
  // Validate approval BEFORE opening even the loopback listener. The hook joins
  // this same one-use admission; no consumed receipt can be replayed by a new host.
  prepared.resources.authorize()
  let submissions = 0
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === scenario.formPath) {
      res.setHeader('content-type', 'text/html'); res.end(`<form method="post" action="${scenario.submitPath}"><input id="secret" name="secret" type="password"><button id="submit" type="submit">Submit</button></form>`)
    } else if (req.method === 'POST' && req.url === scenario.submitPath) {
      let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 2048) req.destroy() })
      req.on('end', () => {
        if (new URLSearchParams(body).get('secret') !== scenario.syntheticPassword || submissions !== 0) { res.writeHead(400); res.end(); return }
        submissions++; res.writeHead(303, { location: scenario.successPath }); res.end()
      })
    } else if (req.method === 'GET' && req.url === scenario.successPath && submissions === 1) {
      res.setHeader('content-type', 'text/html'); res.end('<p id="verified">Synthetic verified</p>')
    } else { res.writeHead(404); res.end() }
  })
  try {
    const url = new URL(scenario.origin)
    server.listen(Number(url.port), url.hostname); await once(server, 'listening')
    const executor = new OwnedChromiumExecutor({ executablePath: '/usr/lib/chromium/chromium', loopbackFixture: true, acceptanceResources: prepared.resources,
    policies: [{ id: scenario.serviceId, formURL: scenario.origin + scenario.formPath, submitURL: scenario.origin + scenario.submitPath, successURL: scenario.origin + scenario.successPath, secretSelector: '#secret', submitSelector: '#submit', verifiedSelector: '#verified' }] })
    await positiveCycle(executor, binding, scenario)
    assert.equal(submissions, 1)
    for (const s of prepared.plan.sessions) await assert.rejects(access(s.directory), { code: 'ENOENT' })
    await access(prepared.root + '/owner.json')
    await writeFile(prepared.root + '/positive-result.json', JSON.stringify({ result: 'passed', submissions, databaseRowsDeleted: 0 }), { flag: 'wx', mode: 0o600 })
  } catch {
    // No extra end/retry: retain uncertain evidence; Playwright's approved internal
    // failure/host-exit handling remains within the original finite scope.
    await writeFile(prepared.root + '/positive-failure.json', JSON.stringify({ result: 'failed-retain-evidence' }), { flag: 'wx', mode: 0o600 })
    process.exitCode = 1
  } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(entry)) void main().catch(() => { console.error('positive lifecycle refused; evidence retained'); process.exitCode = 1 })
