// Synthetic only: node --import tsx lib/secrets/egress-http.bench.ts
// Creates an ephemeral local TLS fixture and compares native HTTPS to an actual
// local data-plane HTTP hop plus the same TLS fixture. No external credentials,
// vendor calls, database, or production resources. The test-only transport maps
// a deterministic public DNS fixture to loopback; production has no such bypass.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as httpServer, request as httpRequest, type IncomingMessage } from 'node:http'
import { createServer as httpsServer, request as httpsRequest } from 'node:https'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { issueEgressCapability } from './egress-capability'
import { executeEgressRequest, pinnedEgressRequestOptions, type EgressHttpRequest, type EgressHttpTarget, type EgressUpstreamResponse } from './egress-http'

async function bytes(message: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of message) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { samples: sorted.length, p50_ms: Number(sorted[Math.ceil(sorted.length * 0.50) - 1].toFixed(3)), p95_ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3)) }
}

async function main() {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const inputs = ['lib/secrets/egress-http.bench.ts', 'lib/secrets/egress-http.ts',
    'lib/secrets/egress-capability.ts', 'lib/secrets/delivery.ts', 'lib/secrets/crypto.ts',
    'packages/protocol/src/task-secrets.ts', 'packages/protocol/src/coded-error.ts', 'pnpm-lock.yaml']
  const sourceFilesSha256 = Object.fromEntries(await Promise.all(inputs.map(async path =>
    [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')],
  )))
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const sourceChanges = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', ...inputs],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean)
  const directory = await mkdtemp(join(tmpdir(), 'mikka-egress-benchmark-'))
  let provider: ReturnType<typeof httpsServer> | undefined
  let application: ReturnType<typeof httpServer> | undefined
  try {
    const keyPath = join(directory, 'fixture-key.pem'), certificatePath = join(directory, 'fixture-cert.pem')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certificatePath,
      '-subj', '/CN=api.fixture.test', '-days', '1', '-addext', 'subjectAltName=DNS:api.fixture.test'], { stdio: 'ignore' })
    const [key, certificate] = await Promise.all([readFile(keyPath), readFile(certificatePath)])
    const secret = randomBytes(24).toString('hex')
    const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
    const responseBody = Buffer.from(JSON.stringify({ ok: true, data: 'x'.repeat(1024) }))
    const requestBody = Buffer.from(JSON.stringify({ text: 'x'.repeat(256) }))
    let vendorRequests = 0, dataPlaneRequests = 0, dnsDecisions = 0
    provider = httpsServer({ key, cert: certificate }, (request, response) => {
      vendorRequests++
      if (request.headers.authorization !== `Bearer ${secret}` || request.url !== '/v1/widgets') { response.writeHead(401); response.end(); return }
      void bytes(request).then(() => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(responseBody) })
    })
    await new Promise<void>(resolve => provider!.listen(0, '127.0.0.1', resolve))
    const vendorPort = (provider.address() as AddressInfo).port
    const origin = `https://api.fixture.test:${vendorPort}`
    const now = Date.now()
    const capability = issueEgressCapability({
      ownerId: 'fixture-owner', workspaceId: 'fixture-workspace', repository: 'fixture/repo', runId: 'fixture-run',
      deviceId: 'fixture-device', deviceTokenId: 'fixture-token', attempt: 1, name: 'FIXTURE_API_KEY', secret,
      secretId: 'fixture-secret', revision: 'a'.repeat(64), leaseExpiresAt: now + 90_000,
      http: { origin, header: 'authorization', prefix: 'Bearer ', rules: [{ method: 'POST', path: '/v1/widgets', match: 'exact' }] },
    }, now, env).capability

    async function fixtureTransport(target: EgressHttpTarget, signal?: AbortSignal): Promise<EgressUpstreamResponse> {
      // The loopback substitution exists only inside this benchmark. All normal
      // execution passes through the production public-address validation first.
      const local = { ...target, address: { address: '127.0.0.1', family: 4 } }
      return await new Promise((resolve, reject) => {
        const outgoing = httpsRequest(local.url, { ...pinnedEgressRequestOptions(local, signal), ca: certificate }, response => {
          void bytes(response).then(body => {
            const headers: Array<[string, string]> = []
            for (let index = 0; index < response.rawHeaders.length; index += 2) headers.push([response.rawHeaders[index], response.rawHeaders[index + 1]])
            resolve({ status: response.statusCode!, headers, body })
          }, reject)
        })
        outgoing.once('error', reject)
        outgoing.end(target.body)
      })
    }

    application = httpServer((request, response) => {
      dataPlaneRequests++
      void (async () => {
        const input = JSON.parse((await bytes(request)).toString('utf8')) as EgressHttpRequest
        const result = await executeEgressRequest(input, { runId: 'fixture-run' }, {
          env, resolve: async () => { dnsDecisions++; return [{ address: '93.184.216.34', family: 4 }] }, transport: fixtureTransport,
        })
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
      })().catch(() => { response.writeHead(500); response.end('{"error":"benchmark_failure"}') })
    })
    await new Promise<void>(resolve => application!.listen(0, '127.0.0.1', resolve))
    const applicationPort = (application.address() as AddressInfo).port
    const envelope = Buffer.from(JSON.stringify({ capability, method: 'POST', path: '/v1/widgets', headers: [['content-type', 'application/json']], bodyBase64: requestBody.toString('base64') }))
    async function direct() {
      const result = await fixtureTransport({
        url: new URL('/v1/widgets', origin), method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'content-length': String(requestBody.length), 'accept-encoding': 'identity' },
        body: requestBody, address: { address: '127.0.0.1', family: 4 },
      })
      assert.equal(result.status, 200); assert.deepEqual(result.body, responseBody)
    }
    async function protectedRequest() {
      const result = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const outgoing = httpRequest(`http://127.0.0.1:${applicationPort}/v1/runs/fixture-run/egress`, {
          method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': envelope.length },
        }, response => { void bytes(response).then(body => resolve({ status: response.statusCode!, body }), reject) })
        outgoing.once('error', reject); outgoing.end(envelope)
      })
      assert.equal(result.status, 200)
      const decoded = JSON.parse(result.body.toString('utf8')) as { status: number; bodyBase64: string }
      assert.equal(decoded.status, 200); assert.deepEqual(Buffer.from(decoded.bodyBase64, 'base64'), responseBody)
    }

    for (let index = 0; index < 20; index++) { await direct(); await protectedRequest() }
    vendorRequests = 0; dataPlaneRequests = 0; dnsDecisions = 0
    const directTimes: number[] = [], protectedTimes: number[] = []
    async function sample(work: () => Promise<void>, values: number[]) {
      const start = performance.now(); await work(); values.push(performance.now() - start)
    }
    for (let index = 0; index < 200; index++) {
      if (index % 2 === 0) { await sample(direct, directTimes); await sample(protectedRequest, protectedTimes) }
      else { await sample(protectedRequest, protectedTimes); await sample(direct, directTimes) }
    }
    assert.equal(vendorRequests, 400); assert.equal(dataPlaneRequests, 200); assert.equal(dnsDecisions, 200)
    const baseline = summary(directTimes), protectedResult = summary(protectedTimes)
    process.stdout.write(JSON.stringify({
      kind: 'synthetic-local-tls', measuredAt: new Date().toISOString(), sourceCommit, sourceChanges, sourceFilesSha256,
      node: process.version, openssl: process.versions.openssl, cpu: cpus()[0]?.model,
      requestBytes: requestBody.length, responseBytes: responseBody.length, warmupPairs: 20,
      direct: { ...baseline, controlPlaneRPCsPerRequest: 0, SQLPerRequest: 0, dataPlaneHopsPerRequest: 0, vendorRequests: 200 },
      protected: { ...protectedResult, controlPlaneRPCsPerRequest: 0, SQLPerRequest: 0, dataPlaneHopsPerRequest: 1, vendorRequests: 200 },
      delta: { p50_ms: Number((protectedResult.p50_ms - baseline.p50_ms).toFixed(3)), p95_ms: Number((protectedResult.p95_ms - baseline.p95_ms).toFixed(3)) },
      limitations: ['Local HTTP client-to-egress hop; real TLS egress-to-vendor fixture.', 'Deterministic public DNS fixture remapped to loopback only by this test transport.', 'No WAN, cold starts, real vendor, native model, GitHub or production acceptance measured.', 'Control-plane RPC/SQL are absent from the dependency path; data-plane HTTPS forwarding is an additional hop.'],
    }, null, 2) + '\n')
  } finally {
    for (const server of [application, provider]) if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    await rm(directory, { recursive: true, force: true })
  }
}
void main().catch(() => { process.stderr.write('Synthetic egress benchmark failed\n'); process.exitCode = 1 })
