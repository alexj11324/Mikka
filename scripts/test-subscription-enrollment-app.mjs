// Cloud Linux: real Next route -> production custody binary -> local TLS fake.
// No database, user credentials, external provider request or deployment.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

assert.equal(process.platform, 'linux')
const source = resolve(import.meta.dirname, '..')
const directory = await mkdtemp(join(tmpdir(), 'mikka-enrollment-next-'))
const snapshot = join(directory, 'app')
const name = `mikka-enrollment-test-${randomUUID()}`
const operator = `fixture-only-${randomUUID()}`
let started = false, vault
const run = (command, args, timeout = 60000) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let result = ''; child.stdout.on('data', part => { if (result.length < 100000) result += part }); child.stderr.resume()
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
  child.on('error', error => { clearTimeout(timer); reject(error) })
  child.on('exit', code => { clearTimeout(timer); if (code === 0) resolve(result.trim()); else reject(new Error(`enrollment acceptance subprocess failed (${code})`)) })
})
try {
  await mkdir(snapshot)
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: source }).toString().split('\0').filter(Boolean)
  for (const file of files) {
    if (file.split('/').some(part => part.startsWith('.env') || ['.git', '.next', '.swc', 'node_modules'].includes(part))) continue
    await mkdir(dirname(join(snapshot, file)), { recursive: true })
    await copyFile(join(source, file), join(snapshot, file))
  }
  const binary = 'packages/subscription-worker/bin/mikka-subscription-enrollment'
  await mkdir(dirname(join(snapshot, binary)), { recursive: true })
  await copyFile(join(source, binary), join(snapshot, binary))
  const certificate = join(directory, 'cert.pem'), key = join(directory, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=Synthetic Mikka vault', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' })
  const records = new Map()
  vault = createServer({ key: await readFile(key), cert: await readFile(certificate) }, async (request, response) => {
    if (request.method !== 'POST' || request.headers.authorization !== 'Bearer fixture-custody-only') { response.writeHead(403).end(); return }
    let raw = ''; for await (const part of request) raw += part
    const body = JSON.parse(raw), name = request.url.split('/').at(-1)
    if (body.secretPath !== '/attempts' || records.has(name)) { response.writeHead(409).end(); return }
    records.set(name, JSON.parse(body.secretValue))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ secret: { secretKey: name, secretValue: body.secretValue, version: 1 } }))
  })
  await new Promise(resolve => vault.listen(0, '127.0.0.1', resolve))
  const reservation = netServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  const env = {
    HOME: '/tmp', XDG_CACHE_HOME: '/tmp/mikka-next-cache', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: 'fixture-next-auth-secret-not-used-for-any-account',
    MIKKA_BYOS_ENROLLMENT_ENABLED: '1', MIKKA_BYOS_ENROLLMENT_OPERATOR_TOKEN: operator,
    MIKKA_BYOS_ENROLLMENT_BINARY: `/workspace/Mikka/${binary}`,
    MIKKA_BYOS_INFISICAL_ORIGIN: `https://127.0.0.1:${vault.address().port}`, MIKKA_BYOS_INFISICAL_PROJECT: 'fixture-project', MIKKA_BYOS_INFISICAL_ENVIRONMENT: 'staging', MIKKA_BYOS_INFISICAL_TOKEN: 'fixture-custody-only',
    MIKKA_BYOS_ENROLLMENT_ATTEMPT_PATH: '/attempts', MIKKA_BYOS_ENROLLMENT_CLAIM_PATH: '/claims', MIKKA_BYOS_ENROLLMENT_GRANT_PATH: '/grants', SSL_CERT_FILE: '/tmp/vault-ca.pem', NO_PROXY: '127.0.0.1',
  }
  const args = ['run', '-d', '--rm', '--name', name, '--network=host', '--memory=4g', '--cpus=2', '--user', `${process.getuid()}:${process.getgid()}`, '-v', `${snapshot}:/workspace/Mikka`, '-v', `${source}/node_modules:/workspace/Mikka/node_modules:ro`, '-v', `${source}/packages/protocol/node_modules:/workspace/Mikka/packages/protocol/node_modules:ro`, '-v', `${certificate}:/tmp/vault-ca.pem:ro`, '-w', '/workspace/Mikka']
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
  args.push('node@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a', 'node', 'node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port))
  await run('docker', args); started = true
  const endpoint = origin + '/mikka/api/subscriptions/enrollments'
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"start"}', signal: AbortSignal.timeout(1500) })
      if (response.status === 401) { ready = true; break }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(ready, 'real Next enrollment route did not become ready')
  assert.equal(records.size, 0)
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operator}` }, body: '{"action":"start"}', signal: AbortSignal.timeout(10000) })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.state, 'awaiting_consent')
  assert.equal(result.taskUseAllowed, false)
  assert.equal(records.size, 1)
  assert.equal(new URL(result.authorizationUrl).searchParams.get('state'), records.get(`mikka-byos-${result.id}`).state)
  console.log('PASS: actual Next startup/route -> production custody worker -> TLS fixture; no SQL/reader/native/E2B; no external OAuth request')
} finally {
  if (started) await run('docker', ['rm', '-f', name])
  if (vault) { vault.closeAllConnections(); await new Promise(resolve => vault.close(resolve)) }
  await rm(directory, { recursive: true, force: true })
}
