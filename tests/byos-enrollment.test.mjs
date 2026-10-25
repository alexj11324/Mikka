// Actual app handler -> private production Go receiver -> TLS vault fixture.
// No database, inference reader, provider account, external OAuth request or UI.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:https'
import { EnrollmentClient, enrollmentHTTP, enrollmentOperator } from '../lib/subscription-enrollment.ts'
import { enrollmentHandoffHTTP } from '../lib/subscription-enrollment-handoff.ts'

test('production receiver persists PKCE before returning a link with no SQL or inference configuration', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-enrollment-'))
  const key = join(directory, 'key.pem'), certificate = join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=Mikka synthetic enrollment', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' })
  const values = new Map()
  const methods = []
  const vault = createServer({ key: await readFile(key), cert: await readFile(certificate) }, async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-custody-only')
    const url = new URL(request.url, 'https://127.0.0.1')
    assert.match(url.pathname, /^\/api\/v4\/secrets\/mikka-byos-[a-f0-9-]{36}$/)
    const name = url.pathname.split('/').at(-1)
    if(request.method==='GET'){assert.equal(url.searchParams.get('secretPath'),'/attempts');const value=values.get(name);if(!value){response.writeHead(404).end();return};response.setHeader('content-type','application/json');response.end(JSON.stringify({secret:{secretKey:name,secretValue:JSON.stringify(value),version:1}}));return}
    assert.equal(request.method,'POST')
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(body.projectId, 'fixture-project')
    assert.equal(body.environment, 'staging')
    if(body.secretPath==='/claims'){methods.push('POST:claimed');response.writeHead(409).end();return}
    assert.equal(body.secretPath, '/attempts')
    methods.push(request.method)
    if (values.has(name)) { response.writeHead(409).end(); return }
    values.set(name, JSON.parse(body.secretValue))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ secret: { secretKey: name, secretValue: body.secretValue, version: 1 } }))
  })
  const oldCA = process.env.SSL_CERT_FILE, oldNoProxy = process.env.NO_PROXY
  try {
    await new Promise(resolve => vault.listen(0, '127.0.0.1', resolve))
    process.env.SSL_CERT_FILE = certificate
    process.env.NO_PROXY = '127.0.0.1'
    const client = new EnrollmentClient({ binary: resolve('packages/subscription-worker/bin/mikka-subscription-enrollment'), infisicalOrigin: `https://127.0.0.1:${vault.address().port}`, project: 'fixture-project', environment: 'staging', workloadToken: 'fixture-custody-only', attemptPath: '/attempts', claimPath: '/claims', grantPath: '/grants' })
    const token = 'fixture-only-operator-token-with-more-than-32-characters'
    const route = enrollmentHTTP({ authorize: async request => enrollmentOperator(request, token), client: () => client })
    const request = (body, authorization = `Bearer ${token}`) => route(new Request('https://mikka.example/api/subscriptions/enrollments', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    assert.equal((await request({ action: 'start' }, 'Bearer invalid')).status, 401)
    assert.equal(values.size, 0)
    const response = await request({ action: 'start' })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.taskUseAllowed, false)
    assert.equal(result.state, 'awaiting_consent')
    assert.equal(values.size, 1)
    const stored = values.get(`mikka-byos-${result.id}`)
    const auth = new URL(result.authorizationUrl)
    assert.equal(auth.origin, 'https://claude.ai')
    assert.equal(auth.searchParams.get('state'), stored.state)
    assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost:54545/callback')
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(stored.verifier.length, 43)
    assert.ok(!JSON.stringify(result).includes(stored.verifier))
    assert.ok(!JSON.stringify(result).includes('fixture-custody-only'))
    assert.deepEqual(methods, ['POST'])
    assert.equal(stored.provider,'claude');assert.equal(stored.handoffDigest.length,64)
    assert.ok(!JSON.stringify(stored).includes(result.handoffKey))
    const handoff=enrollmentHandoffHTTP({enabled:()=>true,client:()=>client})
    const complete=body=>handoff(new Request('https://mikka.example/api/subscriptions/enrollments/handoff',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}))
    const body={id:result.id,provider:'claude',handoffKey:result.handoffKey,callbackUrl:'http://localhost:54545/callback?code=fixture-code&state='+stored.state}
    assert.equal((await complete({...body,handoffKey:'x'.repeat(43)})).status,409)
    assert.equal((await complete({...body,callbackUrl:body.callbackUrl+'&state=x'})).status,409)
    assert.deepEqual(methods,['POST'])
    // A valid scoped proof reaches the actual production shared claim latch;
    // the fake vault refuses it as already claimed, so no provider is contacted.
    assert.equal((await complete(body)).status,409);assert.deepEqual(methods,['POST','POST:claimed'])

  } finally {
    if (oldCA === undefined) delete process.env.SSL_CERT_FILE; else process.env.SSL_CERT_FILE = oldCA
    if (oldNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = oldNoProxy
    vault.closeAllConnections(); await new Promise(resolve => vault.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
