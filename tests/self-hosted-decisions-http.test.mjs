// #1562: the normal community decide() adapter talks to an actual TLS fixture.
// No fetch/Decision/auth/TLS replacement, paid model, PG service or cloud identity.
// Only model-admission policy lookup uses the existing admission test boundary;
// its real PostgreSQL authorization tests remain separate.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const model = 'self-hosted/decision-http-fixture'
const workspaceId = randomUUID()
const question = { type: 'choice', name: 'outcome', instructions: 'Controlled fixture only', choices: [{ value: 'accepted' }] }
const child = `
  import assert from 'node:assert/strict';
  import { mock } from 'node:test';
  let checks = 0;
  mock.module(${JSON.stringify(new URL('../lib/model-admission/runtime.ts', import.meta.url).href)}, {
    namedExports: { assertUnmanagedModelTransport: async (scope, selected) => {
      assert.deepEqual(scope, { workspaceId: ${JSON.stringify(workspaceId)} });
      assert.equal(selected, ${JSON.stringify(model)}); checks++;
    } }
  });
  const { hostedBillingScope } = await import(${JSON.stringify(new URL('../lib/abuse/context.ts', import.meta.url).href)});
  const { decide } = await import(${JSON.stringify(new URL('../lib/coordinator/decide.ts', import.meta.url).href)});
  const result = await hostedBillingScope.run({ workspaceId: ${JSON.stringify(workspaceId)} }, () =>
    decide('self-hosted-tls-fixture', 'Synthetic decision input', [${JSON.stringify(question)}]));
  process.stdout.write(JSON.stringify({ unavailable: result === null,
    accepted: result?.get('outcome')?.choice === 'accepted', policyChecks: checks }));
`

test('self-hosted Decisions use the configured model/key over verified TLS and fail closed', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-decisions-http-'))
  const keyPath = join(directory, 'key.pem'), certificatePath = join(directory, 'cert.pem')
  let server
  t.after(async () => {
    try {
      if (server) {
        server.closeAllConnections()
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certificatePath,
    '-days', '1', '-subj', '/CN=Mikka Decision HTTP fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' })
  const key = 'synthetic-decision-' + randomBytes(24).toString('hex')
  const calls = []
  let mode = 'answer', base = ''
  server = createServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, (request, response) => {
    void (async () => {
      const parts = []
      let size = 0
      for await (const part of request) {
        size += part.length
        if (size > 16_384) throw new Error('Fixture request too large')
        parts.push(part)
      }
      const payload = JSON.parse(Buffer.concat(parts).toString('utf8'))
      // Only closed observations are retained; no auth bytes or request text.
      calls.push({ path: request.url, method: request.method,
        authenticated: request.headers.authorization === `Bearer ${key}`,
        modelMatched: payload.model === model, inputMatched: payload.input === 'Synthetic decision input',
        questionsMatched: JSON.stringify(payload.questions) === JSON.stringify([question]), tls: request.socket.encrypted === true })
      if (mode === 'redirect' && request.url === '/custom/decisions') {
        response.writeHead(307, { location: base + '/credential-sink' }); response.end(); return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ model, provider_metadata: { gateway: { generationId: 'local-tls-fixture', cost: '0' } },
        answers: [{ type: 'choice', name: 'outcome', choice: 'accepted' }] }))
    })().catch(() => { response.writeHead(500); response.end() })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `https://127.0.0.1:${server.address().port}`

  async function invoke({ credential = true, trust = true } = {}) {
    // A closed environment also prevents inherited PostHog/OIDC/proxy/model or
    // database settings from turning this local check into an external request.
    const env = { PATH: process.env.PATH, NODE_ENV: 'test', MIKKA_EDITION: 'community',
      DECISION_MODEL: model, DECISIONS_URL: base + '/custom/decisions',
      ...(trust ? { NODE_EXTRA_CA_CERTS: certificatePath } : {}),
      ...(credential ? { DECISIONS_API_KEY: key, AI_GATEWAY_API_KEY: 'synthetic-unselected-fallback' } : {}) }
    const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', './tests/support/server-only.mjs',
      '--import', 'tsx', '--input-type=module', '--eval', child], { cwd: root, env, timeout: 12_000, maxBuffer: 32_768 })
    assert.equal(result.stdout.includes(key) || result.stderr.includes(key), false)
    return JSON.parse(result.stdout)
  }

  await t.test('the real custom endpoint receives the selected model and dedicated authentication', async () => {
    assert.deepEqual(await invoke(), { unavailable: false, accepted: true, policyChecks: 2 })
    assert.deepEqual(calls, [{ path: '/custom/decisions', method: 'POST', authenticated: true, modelMatched: true,
      inputMatched: true, questionsMatched: true, tls: true }])
  })
  await t.test('a redirect returns null and never sends a second request or credentials to its target', async () => {
    mode = 'redirect'
    const before = calls.length
    assert.deepEqual(await invoke(), { unavailable: true, accepted: false, policyChecks: 2 })
    assert.equal(calls.length - before, 1)
    assert.equal(calls.some(call => call.path === '/credential-sink'), false)
  })
  await t.test('no configured credential returns null without a provider request or admission query', async () => {
    const before = calls.length
    assert.deepEqual(await invoke({ credential: false }), { unavailable: true, accepted: false, policyChecks: 0 })
    assert.equal(calls.length, before)
  })
  await t.test('without this fixture CA, TLS validation rejects the connection before any HTTP request', async () => {
    mode = 'answer'
    const before = calls.length
    assert.deepEqual(await invoke({ trust: false }), { unavailable: true, accepted: false, policyChecks: 2 })
    assert.equal(calls.length, before)
  })
})
