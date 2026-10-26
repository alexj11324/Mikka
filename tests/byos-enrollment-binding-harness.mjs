// Synthetic app session/workspace fixture -> real bind handler -> production Go
// custody process -> disposable Postgres + TLS vault. Not a live user account.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:https'
import { Pool } from 'pg'
import { EnrollmentClient, enrollmentOperator } from '../lib/subscription-enrollment.ts'
import { SubscriptionWorkerClient } from '../packages/daemon/src/subscription-worker-client.ts'
import { SubscriptionRepository } from '../lib/subscription-repository.ts'
import { SubscriptionService } from '../lib/subscription-service.ts'
import { subscriptionHTTP } from '../lib/subscription-http.ts'
import { enrollmentBindHTTP } from '../lib/subscription-enrollment-bind.ts'

export function registerByosEnrollmentBinding(mode) {
  if (!['retained', 'disposal'].includes(mode)) throw new Error('Unknown BYOS binding test mode')
  if (mode === 'disposal' && (process.env.BYOS_FULL_DISPOSAL_AUTHORIZED !== '1' || process.env.RETAIN_SYNTHETIC_RECORDS !== '1')) throw new Error('Pending scoped approval: physical BYOS disposal')
  if (mode === 'retained' && process.env.RETAIN_SYNTHETIC_RECORDS !== '1') throw new Error('Retained BYOS binding requires retained fixtures')
  test(mode === 'retained' ? 'retained enrollment binding: authenticated publication, projection recovery, replay and cleanup configuration status' : 'authenticated binding migrates one escrow through actual canonical publication and recovers projection failure', { timeout: 30000 }, async () => {
  const databaseUrl = process.env.MIKKA_BYOS_TEST_DATABASE_URL
  assert.ok(databaseUrl && new URL(databaseUrl).hostname === '127.0.0.1' && new URL(databaseUrl).pathname.endsWith('_e2e'))
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const workspaceUrl = process.env.MIKKA_BYOS_WORKSPACE_TEST_DATABASE_URL
  assert.ok(workspaceUrl && new URL(workspaceUrl).hostname === '127.0.0.1' && new URL(workspaceUrl).pathname.endsWith('_e2e'))
  assert.notEqual(new URL(workspaceUrl).pathname, new URL(databaseUrl).pathname)
  const workspacePool = new Pool({ connectionString: workspaceUrl, max: 2 })
  const directory = await mkdtemp(join(tmpdir(), 'mikka-enrollment-bind-'))
  const certificate = join(directory, 'cert.pem'), key = join(directory, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=Synthetic bind vault', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' })
  const operator = 'fixture-operator-token-with-more-than-32-characters'
  const principal = `operator:${createHash('sha256').update(operator).digest('hex')}`
  const id = randomUUID(), owner = `fixture-${randomUUID()}`, workspace = randomUUID()
  const values = new Map([
    [`/claims/mikka-byos-${id}`, JSON.stringify({ schema: 'mikka.byos.claim.v1', principal, id })],
    [`/pending/mikka-byos-${id}`, JSON.stringify({ schema: 'mikka.byos.unbound-grant.v1', principal, id, bindingState: 'pending_unbound', provider: 'claude', createdAt: new Date().toISOString(), payload: { type: 'claude', access_token: 'fixture-access-only', refresh_token: 'fixture-retained-refresh', expired: new Date(Date.now() + 3600000).toISOString(), account_uuid: 'fixture-account', organization_uuid: 'fixture-org' } })],
  ])
  const receiptDigest = createHash('sha256').update(`mikka.byos.creation-result.v1:${id}`).digest()
  receiptDigest[6] = (receiptDigest[6] & 15) | 0x40; receiptDigest[8] = (receiptDigest[8] & 63) | 0x80
  const h = receiptDigest.subarray(0,16).toString('hex')
  const receiptName = `mikka-byos-${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
  values.set(`/claims/${receiptName}`, JSON.stringify({schema:'mikka.byos.creation-result.v1',principal,id,digest:createHash('sha256').update(values.get(`/pending/mikka-byos-${id}`)).digest('hex'),grantUncertain:false,attemptSettled:true}))
  let failProjection = true, failSourceDeletes = true
  const vault = createServer({ key: await readFile(key), cert: await readFile(certificate) }, async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-custody')
    const url = new URL(request.url, 'https://127.0.0.1'), name = url.pathname.split('/').at(-1)
    let body = {}; if (request.method !== 'GET') { let raw = ''; for await (const chunk of request) raw += chunk; body = JSON.parse(raw) }
    const path = request.method === 'GET' ? url.searchParams.get('secretPath') : body.secretPath
    const lookup = `${path}/${name}`
    if (request.method === 'POST') {
      if (failProjection && path === '/access') { response.writeHead(503).end(); return }
      if (values.has(lookup)) { response.writeHead(409).end(); return }
      values.set(lookup, body.secretValue)
    } else if (request.method === 'DELETE') { if (failSourceDeletes && ['/pending','/attempts'].includes(path)) { response.writeHead(503).end(); return }; values.delete(lookup); response.writeHead(200).end('{}'); return } else assert.equal(request.method, 'GET')
    if (!values.has(lookup)) { response.writeHead(404).end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ secret: { secretKey: name, secretValue: values.get(lookup), version: 1 } }))
  })
  const oldCA = process.env.SSL_CERT_FILE, oldNoProxy = process.env.NO_PROXY
  try {
    await workspacePool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,\'Synthetic binding fixture\')', [workspace, owner])
    await workspacePool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,\'Fixture\',\'fixture@example.invalid\',\'admin\')', [workspace, owner])
    await new Promise(resolve => vault.listen(0, '127.0.0.1', resolve))
    process.env.SSL_CERT_FILE = certificate; process.env.NO_PROXY = '127.0.0.1'
    const client = new EnrollmentClient({ binary: resolve('packages/subscription-worker/bin/mikka-subscription-enrollment'), infisicalOrigin: `https://127.0.0.1:${vault.address().port}`, project: 'fixture-project', environment: 'staging', workloadToken: 'fixture-custody', attemptPath: '/attempts', claimPath: '/claims', grantPath: '/pending', databaseUrl, canonicalGrantPath: '/canonical', accessPath: '/access' })
    const route = enrollmentBindHTTP({ operator: async request => enrollmentOperator(request, operator), session: async request => request.headers.get('cookie') === 'synthetic-session=valid' ? { userId: owner } : null, workspace: async (user, id) => { const { rowCount } = await workspacePool.query('select 1 from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 and status=\'active\'', [id, user]); if (!rowCount) throw new Error('denied') }, client: () => client })
    const post = (body, cookie = 'synthetic-session=valid') => route(new Request('https://mikka.example/api/subscriptions/enrollments/bind', { method: 'POST', headers: { authorization: `Bearer ${operator}`, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    assert.equal((await post({ id, workspaceId: workspace }, '')).status, 401)
    assert.equal((await post({ id, workspaceId: randomUUID() })).status, 409)
    assert.equal((await post({ id, workspaceId: workspace })).status, 409)
    const before = (await pool.query('select c.id,c.epoch,c."stagedSecretName",c."stagedAccessName" from byos_enrollment_transfers t join byos_connections c on c.id=t."connectionId" where t."enrollmentId"=$1', [id])).rows[0]
    assert.ok(before.stagedSecretName && before.stagedAccessName)
    failProjection = false
    const response = await post({ id, workspaceId: workspace })
    assert.equal(response.status, 200)
    const bound = await response.json()
    assert.equal(bound.id, before.id); assert.equal(bound.revision, Number(before.epoch)); assert.equal(bound.state, 'connected')
    const canonical = JSON.parse(values.get(`/canonical/${before.stagedSecretName}`)), access = JSON.parse(values.get(`/access/${before.stagedAccessName}`))
    assert.equal(canonical.ownerId, owner); assert.equal(canonical.workspaceId, workspace); assert.equal(canonical.payload.refresh_token, 'fixture-retained-refresh')
    assert.equal(access.payload.refresh_token, undefined)
    assert.ok(values.has(`/pending/mikka-byos-${id}`)); assert.equal(bound.cleanup.enrollment.state, 'deletion_failed'); assert.equal(bound.cleanup.failed, 2)
    const repeated = await post({ id, workspaceId: workspace }); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).id, bound.id)
    // The cron/service selector must find source-only leftovers, with no
    // inference reader and no retired canonical artifacts to select instead.
    let invalidCleanupConfig = false
    const service = new SubscriptionService(new SubscriptionRepository(pool), scope => new SubscriptionWorkerClient({binary:resolve('packages/subscription-worker/bin/mikka-subscription-worker'),env:{SSL_CERT_FILE:certificate}}, {scope,databaseUrl,infisicalOrigin:`https://127.0.0.1:${vault.address().port}`,project:'fixture-project',environment:'staging',path:'/canonical',workloadToken:'fixture-custody',accessPath:'/access',enrollmentAttemptPath:'/attempts',enrollmentClaimPath:'/claims',enrollmentGrantPath:invalidCleanupConfig ? '/attempts' : '/pending',enableRuntime:false}), {ready:()=>false,nativeIsolation:'none'}, undefined, async (user, workspaceId) => {assert.equal(user,owner);assert.equal(workspaceId,workspace)})
    invalidCleanupConfig = true
    const misconfigured = await service.status(owner,bound.id);assert.equal(misconfigured.state,'connected');assert.equal(misconfigured.cleanup.enrollment.state,'configuration_required')
    // Remaining assertions use Worker.Cleanup, which physically deletes OAuth attempt rows.
    if (mode === 'retained') return
    invalidCleanupConfig = false
    failSourceDeletes = false
    // Other integration cases share this disposable database. Drain bounded
    // fair batches until this connection is reached rather than assuming it is
    // the only queued connection.
    for (let attempt=0; attempt<24 && values.has(`/pending/mikka-byos-${id}`); attempt++) {
      const batch = await service.cleanupBatch(); assert.ok(batch.processed>0 && batch.processed<=2)
    }
    const cleaned = await service.status(owner,bound.id);assert.equal(cleaned.cleanup.pending,0);assert.equal(cleaned.cleanup.enrollment.state,'complete')
    assert.ok(!values.has(`/pending/mikka-byos-${id}`))
    const afterPurge = await post({id,workspaceId:workspace});assert.equal(afterPurge.status,200);assert.equal((await afterPurge.json()).id,bound.id)
    invalidCleanupConfig = true // Canonical disconnect must still fence with partial/duplicate source paths.
    const control = subscriptionHTTP({session:async()=>({userId:owner,sessionId:'synthetic-session'}),workspace:async()=>{},service:custodyOnly=>{assert.equal(custodyOnly,true);return service}})
    const disconnected = await control(new Request('https://mikka.example/api/subscriptions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'disconnect',connectionId:bound.id,revision:bound.revision})}))
    assert.equal(disconnected.status,200)
    const result = await disconnected.json();assert.equal(result.state,'disconnected');assert.equal(result.cleanup.pending,1);assert.equal(result.cleanup.uncertainCreates,1);assert.equal(result.cleanup.providerRevocation,'not_implemented')
    // Initial projection POST returned 503: DELETE removed the active value,
    // but a late remote commit remains possible and must stay visibly queued.
    assert.ok(!values.has(`/canonical/${before.stagedSecretName}`));assert.ok(!values.has(`/access/${before.stagedAccessName}`))
    assert.equal((await post({id,workspaceId:workspace})).status,409)

  } finally {
    if (oldCA === undefined) delete process.env.SSL_CERT_FILE; else process.env.SSL_CERT_FILE = oldCA
    if (oldNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = oldNoProxy
    vault.closeAllConnections(); await new Promise(resolve => vault.close(resolve)); await pool.end(); await workspacePool.end()
    console.log(JSON.stringify({ fixture: `byos-binding-${mode}`, directory, disposition: 'retained' }))
  }
})

}
