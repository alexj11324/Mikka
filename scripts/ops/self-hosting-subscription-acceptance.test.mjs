import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { accessFixture, cleanupScope, ownedComputerVMs, ownedNativeVMs, independentProviders, readProductionAccessLocation, readAuthorizedProjection, configureBoundSubscription, readCheckedSourceMetadata, safeThreadFailure, safeRepositoryFailure, safeSourceFailures, deliveryTask, deliveryReceipt, cleanupDelivery, cloudChatResult, cloudModelBillingReceipt, vaultLogsContainPlaintext, inspectCommunityMonitoring, selectSharedTeam, idleRequestKind, idleRuntimeReceipt, communityReleaseCompatibility, mailpitNotifications, selectOfficialInstallation, assertCommunityAdmission } from './self-hosting-subscription-acceptance.mjs'

test('Mailpit v1.27.4 coalesced notification frame preserves the matching new mail after an update', () => {
  const update = { Type: 'update', Data: { Total: 1 } }
  const arrival = { Type: 'new', Data: { ID: 'owned-message', To: [{ Address: 'fixture@example.invalid' }] } }
  const frame = JSON.stringify(update) + '\n' + JSON.stringify(arrival) + '\n'
  assert.deepEqual(mailpitNotifications(frame), [update, arrival])
  assert.deepEqual(mailpitNotifications(JSON.stringify(arrival)), [arrival])
})

test('Mailpit invalid lines cannot hide a later notification or turn primitive data into an arrival', () => {
  const arrival = { Type: 'new', Data: { ID: 'owned-message', Subject: 'escaped\nnewline' } }
  assert.deepEqual(mailpitNotifications('invalid\nnull\n42\n[]\n' + JSON.stringify(arrival)), [arrival])
})

test('an immutable published image may serve a descendant with only mobile, documentation or locale changes', () => {
  const image = '9bcdefc5fe0c047393d581eea867ffa801f53dbe', publicRevision = 'bb5d1f9e224aea395b9c45823960e8ad10f1a099'
  assert.equal(communityReleaseCompatibility(image, image).kind, 'same_revision')
  const files = ['apps/mobile/lib/web.ts', 'docs/design/mobile.md', 'messages/en.json', 'messages/zh-CN.json']
    .map(filename => ({ filename, status: 'modified' }))
  const comparison = { status: 'ahead', behind_by: 0, merge_base_commit: { sha: image }, files }
  const proof = communityReleaseCompatibility(image, publicRevision, comparison)
  assert.equal(proof.imageRevision, image); assert.equal(proof.publicRevision, publicRevision)
  assert.deepEqual(proof.changedPaths, files.map(row => row.filename).sort())
  assert.equal(proof.kind, 'mobile_documentation_or_locale')
})

test('image reuse rejects backend changes, hidden renames, removed locales, truncation and divergent history', () => {
  const image = '9bcdefc5fe0c047393d581eea867ffa801f53dbe', publicRevision = 'bb5d1f9e224aea395b9c45823960e8ad10f1a099'
  const comparison = { status: 'ahead', behind_by: 0, merge_base_commit: { sha: image }, files: [{ filename: 'apps/mobile/lib/web.ts', status: 'modified' }] }
  for (const filename of ['lib/auth.ts', 'app/api/cloud/connect/route.ts', 'packages/daemon/assets/subagent-gateway.py', 'package.json']) {
    assert.throws(() => communityReleaseCompatibility(image, publicRevision, { ...comparison, files: [{ filename, status: 'modified' }] }), /RELEASE_DIFF/)
  }
  for (const files of [[{ filename: 'apps/mobile/moved.ts', previous_filename: 'lib/auth.ts', status: 'renamed' }],
    [{ filename: 'messages/en.json', status: 'removed' }], Array.from({ length: 300 }, (_, n) => ({ filename: 'docs/' + n, status: 'added' }))]) {
    assert.throws(() => communityReleaseCompatibility(image, publicRevision, { ...comparison, files }), /RELEASE_DIFF/)
  }
  for (const patch of [{ status: 'diverged' }, { behind_by: 1 }, { merge_base_commit: { sha: publicRevision } }]) {
    assert.throws(() => communityReleaseCompatibility(image, publicRevision, { ...comparison, ...patch }), /RELEASE_ANCESTRY/)
  }
})

test('published acceptance can retain its deployed source while a descendant main is only being built', async () => {
  const { communityPublishedAncestry } = await import('./self-hosting-subscription-acceptance.mjs')
  const published = '1'.repeat(40), next = '2'.repeat(40)
  assert.equal(communityPublishedAncestry(published, published).kind, 'same_revision')
  assert.deepEqual(communityPublishedAncestry(published, next, {
    status: 'ahead', behind_by: 0, merge_base_commit: { sha: published },
  }), { publicRevision: published, mainRevision: next, kind: 'main_ahead_of_deployed_source' })
})

test('published acceptance rejects a rollback, divergence, missing ancestry or another merge base', async () => {
  const { communityPublishedAncestry } = await import('./self-hosting-subscription-acceptance.mjs')
  const published = '1'.repeat(40), next = '2'.repeat(40)
  const good = { status: 'ahead', behind_by: 0, merge_base_commit: { sha: published } }
  for (const comparison of [undefined, { ...good, status: 'behind' }, { ...good, status: 'diverged' },
    { ...good, behind_by: 1 }, { ...good, merge_base_commit: { sha: next } }]) {
    assert.throws(() => communityPublishedAncestry(published, next, comparison), /RELEASE_MAIN_ANCESTRY/)
  }
})

test('published and main pins must be immutable even when their labels or histories match', async () => {
  const { communityPublishedAncestry } = await import('./self-hosting-subscription-acceptance.mjs')
  for (const [published, main] of [['main', 'main'], ['1'.repeat(40), undefined], ['1'.repeat(40), 'branch-name']]) {
    assert.throws(() => communityPublishedAncestry(published, main), /RELEASE_BINDING/)
  }
})

test('runtime idle accounting separates existing infrastructure and never retains private URL data', () => {
  const origin = 'https://owned.trycloudflare.com'
  assert.equal(idleRequestKind(origin + '/mikka/api/rpc?private=secret-fixture', origin), 'data_api')
  assert.equal(idleRequestKind(origin + '/api/rpc?private=secret-fixture', origin), 'data_api')
  assert.equal(idleRequestKind(origin + '/mikka/api/live/ticket?token=secret-fixture', origin), 'live_ticket')
  assert.equal(idleRequestKind(origin + '/mikka/api/auth/get-session', origin), 'auth')
  assert.equal(idleRequestKind(origin + '/mikka/api/version', origin), 'version')
  assert.equal(idleRequestKind('https://other.invalid/mikka/api/rpc?token=secret-fixture', origin), 'external')
  assert.equal(idleRequestKind('invalid private value', origin), 'invalid')
  assert.equal(idleRequestKind(origin + '/mikka/assets/private.js', origin), 'asset')
})

test('an actual full visible minute and connected live channel are required for idle runtime proof', () => {
  const valid = { elapsedMs: 60002, counts: { data_api: 0, version: 1, auth: 0, live_ticket: 1, external: 0, asset: 0, invalid: 0 },
    visibleStart: true, visibleEnd: true, liveStart: true, liveEnd: true, disconnections: 0, pageErrors: 0 }
  const receipt = idleRuntimeReceipt(valid)
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.dataReadRequests, 0)
  assert.equal(receipt.scope, 'visible_selfhost_browser_requests_not_sql_instrumentation')
  for (const patch of [{ counts: { ...valid.counts, data_api: 1 } }, { visibleEnd: false }, { liveStart: false },
    { liveEnd: false }, { disconnections: 1 }, { pageErrors: 1 }]) assert.equal(idleRuntimeReceipt({ ...valid, ...patch }).status, 'failed')
  for (const elapsedMs of [59999, 90001, NaN]) assert.throws(() => idleRuntimeReceipt({ ...valid, elapsedMs }), /IDLE_RUNTIME_METRICS/)
  assert.throws(() => idleRuntimeReceipt({ ...valid, counts: { ...valid.counts, data_api: -1 } }), /IDLE_RUNTIME_METRICS/)
  assert.equal(JSON.stringify(receipt).includes('secret-fixture'), false)
})

const ledgerModel = 'openai/gpt-6-luna', ledgerWorkspace = '11111111-1111-4111-8111-111111111111'
const ledgerPayer = '22222222-2222-4222-8222-222222222222'
const ledgerRow = () => ({ model: ledgerModel, workspaceMatches: true, ledgerPayerMatches: true,
  usageModelMatches: true, credentialKind: 'user', payerWorkspace: ledgerWorkspace, state: 'settled',
  inputTokens: '12', outputTokens: '8', costMicroUsd: '27', completed: true })

test('cloud billing accepts the settled default and its zero-counter Decision ledger without exporting payer IDs', () => {
  const rows = [ledgerRow(), { ...ledgerRow(), model: 'openai/gpt-6-luna-decisions', inputTokens: '0', outputTokens: '0' }]
  const receipt = cloudModelBillingReceipt(rows,ledgerModel,ledgerWorkspace)
  assert.equal(receipt[0].payerKind,'workspace')
  assert.equal(receipt[0].outputTokens,8)
  assert.equal(receipt[1].costMicroUsd,27)
  assert.equal(receipt[1].outputTokens,0)
  assert.ok(!JSON.stringify(receipt).includes(ledgerWorkspace))
})

test('shared or solo personal credits require independent authorization and matching grant and ledger scopes', () => {
  const row = { ...ledgerRow(), payerWorkspace: ledgerPayer }
  for (const kind of ['shared_credit','solo_credit']) {
    const receipt = cloudModelBillingReceipt([row],ledgerModel,ledgerWorkspace,new Map([[ledgerPayer,kind]]))
    assert.equal(receipt[0].payerKind,kind)
    assert.ok(!JSON.stringify(receipt).includes(ledgerPayer))
  }
  assert.throws(()=>cloudModelBillingReceipt([row],ledgerModel,ledgerWorkspace),/LEDGER_SCOPE/)
  for (const patch of [{workspaceMatches:false},{ledgerPayerMatches:false},{usageModelMatches:false},
    {credentialKind:'server_key'},{model:'openai/unrequested'},{payerWorkspace:'foreign'}])
    assert.throws(()=>cloudModelBillingReceipt([{...ledgerRow(),...patch}],ledgerModel,ledgerWorkspace),/LEDGER_SCOPE/)
})

test('cloud billing refuses truncated inventories and requires a completed settled nonempty default reply', () => {
  for (const rows of [[],Array.from({length:13},ledgerRow)])
    assert.throws(()=>cloudModelBillingReceipt(rows,ledgerModel,ledgerWorkspace),/LEDGER_COUNT/)
  for (const patch of [{state:'pending'},{completed:false},{outputTokens:0},{outputTokens:null},
    {model:'openai/gpt-6-luna-decisions'}])
    assert.throws(()=>cloudModelBillingReceipt([{...ledgerRow(),...patch}],ledgerModel,ledgerWorkspace),/LEDGER/)
})

test('vault log inspection requires both real streams and detects username or password in stderr too',()=>{
  const values=['synthetic-vault-password','synthetic-vault-account']
  assert.equal(vaultLogsContainPlaintext({stdout:'normal output',stderr:'normal error'},values),false)
  for(const field of ['stdout','stderr'])for(const value of values){
    assert.equal(vaultLogsContainPlaintext({stdout:'',stderr:'',[field]:'prefix '+value+' suffix'},values),true)
  }
  for(const logs of ['',{stdout:''},{stderr:''},{stdout:undefined,stderr:''}]){
    assert.throws(()=>vaultLogsContainPlaintext(logs,values),/LOG_STREAMS/)
  }
})

test('a full delivery requires one real owned draft PR and its single requested file', () => {
  const task = deliveryTask('42426341416', 'claude', 'a'.repeat(40))
  assert.equal(task.model, 'claude-haiku-5-5')
  assert.equal(deliveryTask('42426341416', 'codex', 'a'.repeat(40)).model, 'gpt-6-luna')
  for (const [run, harness, revision] of [['../escape','claude','a'.repeat(40)], ['42426341416','pro','a'.repeat(40)], ['42426341416','codex','main']])
    assert.throws(() => deliveryTask(run,harness,revision), /DELIVERY_SCOPE/)
  const pr = { state: 'open', draft: true, number: 1700, html_url: 'https://github.com/alexj11324/Mikka/pull/1700',
    head: { ref: task.branch, sha: 'b'.repeat(40), repo: { full_name: 'alexj11324/Mikka' } },
    base: { ref: 'main', repo: { full_name: 'alexj11324/Mikka' } } }
  const files = [{ filename: task.path, status: 'added', additions: 5 }]
  assert.equal(deliveryReceipt(task, [pr], files).clonePushAndPullRequest, true)
  assert.throws(() => deliveryReceipt(task, [], files), /DELIVERY_PR_COUNT/)
  assert.throws(() => deliveryReceipt(task, [pr,pr], files), /DELIVERY_PR_COUNT/)
  assert.throws(() => deliveryReceipt(task, [{ ...pr, head: { ...pr.head, ref: 'unrelated' } }], files), /DELIVERY_PR_SCOPE/)
  assert.throws(() => deliveryReceipt(task, [{ ...pr, base: { ...pr.base, ref: 'release' } }], files), /DELIVERY_PR_SCOPE/)
  assert.throws(() => deliveryReceipt(task, [pr], [{ ...files[0], filename: 'lib/auth.ts' }]), /DELIVERY_FILE_SCOPE/)
  assert.throws(() => deliveryReceipt(task, [pr], [...files,...files]), /DELIVERY_FILE_SCOPE/)
})

test('cloud replies and quota refusals stay correlated to the submitted chat without retaining content', () => {
  const marker = 'owned-marker', person = { from: 'person', text: 'Reply with ' + marker }
  const reply = { from: 'coordinator', text: marker + ' private-provider-text' }
  assert.equal(cloudChatResult({ working: false, items: [reply] }, marker), null)
  assert.equal(cloudChatResult({ working: true, items: [person,reply] }, marker), null)
  const success = cloudChatResult({ working: false, items: [person,reply] }, marker)
  assert.equal(success.status, 'passed'); assert.equal(success.replySha256.length,64)
  assert.ok(!JSON.stringify(success).includes('private-provider-text'))
  const quota = cloudChatResult({ working: false, items: [person], error: 'cloud_quota_exhausted',
    failure: { kind: 'failed', cloudCode: 'cloud_quota_exhausted', raw: 'secret-private-provider-text' } }, marker, true)
  assert.deepEqual(quota, { status: 'passed', code: 'cloud_quota_exhausted', messageKey: 'RunErrors.cloud_quota_exhausted.default' })
  assert.equal(cloudChatResult({ working: false, items: [person,reply] }, marker, true).code, 'COMMUNITY_CLOUD_QUOTA_NOT_ENFORCED')
  assert.equal(cloudChatResult({ working: false, items: [person], failure: { cloudCode: 'cloud_server_revoked' } }, marker, true).status, 'refused')
  assert.equal(cloudChatResult({ working: false, items: [person], error: 'private-provider-text' }, marker).code, 'COMMUNITY_CLOUD_CHAT_FAILED')
})

test('delivery cleanup closes only its verified PR and refuses a branch whose head moved', async () => {
  const task = deliveryTask('42426341416','codex','a'.repeat(40)), head = 'b'.repeat(40)
  const pr = { state: 'open', draft: true, number: 1701, html_url: 'https://github.com/alexj11324/Mikka/pull/1701',
    head: { ref: task.branch, sha: head, repo: { full_name: 'alexj11324/Mikka' } },
    base: { ref: 'main', repo: { full_name: 'alexj11324/Mikka' } } }
  const files = [{ filename: task.path, status: 'added', additions: 5 }], calls = []
  const github = async (path, method = 'GET', body) => {
    calls.push({ path, method, body })
    if (method === 'GET') return { ref: 'refs/heads/' + task.branch, object: { sha: head } }
    if (method === 'PATCH') return { number: pr.number, state: 'closed', merged: false, head: { sha: head } }
    return null
  }
  assert.deepEqual(await cleanupDelivery(task,[pr],files,github), { pullRequestClosed: true, branchDeleted: true })
  assert.deepEqual(calls.map(x=>[x.method,x.path]), [['GET','/git/ref/heads/'+task.branch],['PATCH','/pulls/1701'],['DELETE','/git/refs/heads/'+task.branch]])
  let writes = 0
  await assert.rejects(cleanupDelivery(task,[pr],files,async (_path,method = 'GET') => {
    if (method !== 'GET') writes++
    return { ref: 'refs/heads/' + task.branch, object: { sha: 'c'.repeat(40) } }
  }), /DELIVERY_CLEANUP_HEAD/)
  assert.equal(writes,0)
})
const target = { ownerId: 'owned-local-user', workspaceId: '11111111-1111-4111-8111-111111111111', connectionId: '22222222-2222-4222-8222-222222222222' }
const row = { id: '33333333-3333-4333-8333-333333333333', ownerId: 'authorized-owner', workspaceId: '44444444-4444-4444-8444-444444444444', provider: 'codex' }
const bundle = () => ({ schema: 1, connectionId: row.id, ownerId: row.ownerId, workspaceId: row.workspaceId, provider: row.provider,
  payload: { type: 'codex', access_token: 'synthetic-access-only', account_id: 'synthetic-provider-id', expired: new Date(3600000).toISOString() } })
const args = value => { const raw = JSON.stringify(value); return [raw, { ...row, accessDigest: createHash('sha256').update(raw).digest('hex') }, target, 0] }
test('only an intact authorized access projection can be rebound to the isolated installation', () => {
  const source = bundle(), out = accessFixture(...args(source)), value = JSON.parse(out.value)
  assert.equal(value.ownerId, target.ownerId); assert.equal(value.workspaceId, target.workspaceId); assert.equal(value.connectionId, target.connectionId)
  assert.deepEqual(value.payload, source.payload)
  assert.equal(out.digest, createHash('sha256').update(out.value).digest('hex'))
  const a = args(source); a[1].ownerId = 'someone-else'; assert.throws(() => accessFixture(...a), /SOURCE_SCOPE/)
  const b = args(source); b[0] += ' '; assert.throws(() => accessFixture(...b), /SOURCE_DIGEST/)
})
test('canonical and nested refresh grants are refused before any dev secret is written', () => {
  for (const key of ['refresh_token', 'id_token']) for (const nested of [false, true]) {
    const value = bundle(); if (nested) value.payload.siwc = { [key]: 'synthetic-forbidden' }; else value.payload[key] = 'synthetic-forbidden'
    assert.throws(() => accessFixture(...args(value)), /ACCESS_ONLY/)
  }
})
test('a short-lived projection cannot start a thread or copy a refresh grant for renewal', () => {
  const value = bundle(); value.payload.expired = new Date(1_199_999).toISOString()
  assert.throws(() => accessFixture(...args(value)), /SOURCE_EXPIRY/)
  const a = args(bundle()); a[2] = { ...target, workspaceId: 'not-a-workspace' }; assert.throws(() => accessFixture(...a), /FIXTURE_SCOPE/)
})
test('independent cleanup can remove only this run exact dev folder and at most its three VM identities', () => {
  const run = '42385723293', value = { run, project: '89850d6a-f020-4936-863e-df77380dfe40', environment: 'dev', path: '/release-selfhost-' + run, folder: target.workspaceId, vms: ['owned-vm-id'] }
  assert.equal(cleanupScope(value, run), value)
  for (const patch of [{ environment: 'prod' }, { path: '/byos-access' }, { run: '42385723294' }, { vms: ['one-vm-id', 'two-vm-id', 'third-vm-id', 'fourth-vm-id'] }, { computerWorkspace: 'not-a-workspace' }, { folder: '../arbitrary' }]) assert.throws(() => cleanupScope({ ...value, ...patch }, run), /CLEANUP_SCOPE/)
})

// Real core image D75 additionally passed the ordinary auth/MCP contract with zero model calls.

// Staging checkpoint: access-only fixture constraints and owned volume cleanup verified.

test('a failed provider source or fixture preserves the independent bound model and executes the other provider', async () => {
  for (const stage of ['source-authorization', 'subscription-fixture']) {
    const providers = [{ provider: 'claude', model: 'claude-haiku-5-5', receipt: {} }, { provider: 'codex', model: 'gpt-6-luna', receipt: {} }]
    const called = []
    await independentProviders(providers, stage, async source => {
      called.push(source.model)
      if (source.provider === 'claude') throw Error('COMMUNITY_SOURCE_EXPIRY')
      source.receipt.status = 'passed'
    })
    assert.deepEqual(called, ['claude-haiku-5-5', 'gpt-6-luna'])
    assert.equal(providers[0].receipt.code, 'COMMUNITY_SOURCE_EXPIRY')
    assert.equal(providers[1].receipt.status, 'passed')
    assert.equal(providers[1].model, 'gpt-6-luna')
  }
})

// Release checkpoint: Apple status is read-only, separate from device acceptance.

// Final release checkpoint: public ce67; production execution follows private main READY.

// Public protocol checkpoint: ce67 bridge; native/full threads follow the final fixed source.

// Public release checkpoint: dispatch uses the commit subject prefix, independent of its explanatory body.

// YAML mode expressions use block scalars because the commit prefix contains a colon.

// PR comments use explicit Pull requests write; Apple/EAS readbacks run independently of protocol completion.

// Apple readback JWT scope includes the exact fixed build filters and sparse fields; no native redispatch.

// Community release pin contains native-auth fix1668; production writers must complete before activation.


test('access source uses the actual production configuration and its distinct access project without reading unrelated values', async () => {
  const publicProject = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
  const values = { MIKKA_BYOS_INFISICAL_PROJECT: '11111111-1111-4111-8111-111111111111', MIKKA_BYOS_ACCESS_INFISICAL_PROJECT: '22222222-2222-4222-8222-222222222222', MIKKA_BYOS_INFISICAL_ENVIRONMENT: 'prod', MIKKA_BYOS_ACCESS_INFISICAL_PATH: '/actual-access' }
  const calls = [], rows = Object.keys(values).map((key, i) => ({ id: 'config'+i, key, type: 'sensitive', target: ['production'] }))
  rows.push({ id: 'never-read-private', key: 'PRIVATE_APPLICATION_SECRET', target: ['production'] })
  const sourceCalls = [], report = {}
  const location = await readProductionAccessLocation(async path => {
    calls.push(path)
    assert.equal(path, '/v10/projects/'+publicProject+'/env')
    return { envs: rows }
  }, async key => { sourceCalls.push(key); assert.ok(key in values); return values[key] }, report)
  assert.deepEqual(location, { project: values.MIKKA_BYOS_ACCESS_INFISICAL_PROJECT, environment: 'prod', path: '/actual-access' })
  assert.equal(calls.length, 1); assert.equal(sourceCalls.length, 4); assert.ok(sourceCalls.every(key => key in values))
  assert.ok(Object.values(report.sourceSelectorTypes).every(type => type === 'sensitive')); assert.equal(report.sourceLocationShape.projectIsUuid, true)
})

test('source projection reuses the normal custody identity for exactly one immutable access leaf and never exports its bearer', async () => {
  const calls = [], report = { sourceRequests: [] }, name = 'mikka-byos-33333333-3333-4333-8333-333333333333'
  const location = { project: '22222222-2222-4222-8222-222222222222', environment: 'prod', path: '/actual-access' }
  const value = 'synthetic-access-only'
  const raw = await readAuthorizedProjection({ location, name, clientId: 'existing-custody', clientSecret: 'synthetic-custody-secret', report,
    fetcher: async (url, init) => {
      const u = new URL(url); calls.push({ path: u.pathname, method: init.method })
      assert.equal(u.origin, 'https://app.infisical.com'); assert.equal(init.redirect, 'error')
      if (u.pathname === '/api/v1/auth/universal-auth/login') {
        assert.deepEqual(JSON.parse(init.body), { clientId: 'existing-custody', clientSecret: 'synthetic-custody-secret' })
        return Response.json({ accessToken: 'synthetic-derived-bearer', tokenType: 'Bearer' })
      }
      assert.equal(u.pathname, '/api/v4/secrets/'+name)
      assert.equal(u.searchParams.get('projectId'), location.project); assert.equal(u.searchParams.get('secretPath'), location.path)
      assert.equal(u.searchParams.get('version'), '1'); assert.equal(u.searchParams.get('expandSecretReferences'), 'false')
      assert.equal(init.headers.authorization, 'Bearer synthetic-derived-bearer')
      return Response.json({ secret: { secretKey: name, version: 1, secretValue: value } })
    } })
  assert.equal(raw, value); assert.equal(calls.length, 2)
  for (const secret of [value, 'synthetic-derived-bearer', 'synthetic-custody-secret']) assert.ok(!JSON.stringify(report).includes(secret))
  await assert.rejects(readAuthorizedProjection({ location, name: 'canonical-grant', report, fetcher: () => assert.fail('must not request') }), /SOURCE_PROJECTION_SCOPE/)
})


test('model selection materializes virtual defaults before removal and binds exactly the original small subscription', async () => {
  let customized = false, location = 'cloud', autoModelRouting = true, preferredHarness = 'claude_code'
  const selected = { harness: 'claude_code', model: 'claude-haiku-5-5', localConnection: target.connectionId }
  let entries = [
    { id: 'default:claude', harness: selected.harness, model: selected.model, source: { kind: 'subscription', connectionId: selected.localConnection } },
    { id: 'default:codex', harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: row.id } },
  ]
  const client = { rpc: async (action, args) => {
    if (action === 'model-order.getModelOrder') return structuredClone({ entries, location, autoModelRouting, preferredHarness })
    const [change] = args
    if (change.kind === 'location') { location = change.location; return }
    if (change.kind === 'preferred') { preferredHarness = change.harness; return }
    if (change.kind === 'autoRouting') { autoModelRouting = change.enabled; return }
    if (!customized) {
      const mapping = new Map(entries.map((e, i) => [e.id, 'stored-'+i])); entries = entries.map(e => ({ ...e, id: mapping.get(e.id) })); customized = true
      if (change.kind === 'remove') change.id = mapping.get(change.id) ?? change.id
    }
    if (change.kind === 'remove') { assert.ok(entries.some(e => e.id === change.id), 'virtual default id became stale'); entries = entries.filter(e => e.id !== change.id) }
    if (change.kind === 'add') for (const e of change.entries) if (!entries.some(old => old.harness === e.harness && old.model === e.model && old.source.connectionId === e.source.connectionId)) entries.push({ ...e, id: 'added' })
  } }
  await configureBoundSubscription(client, target.workspaceId, selected)
  assert.equal(entries.length, 1); assert.equal(entries[0].model, selected.model); assert.equal(entries[0].source.connectionId, selected.localConnection)
  assert.equal(location, 'local'); assert.equal(autoModelRouting, false); assert.equal(preferredHarness, selected.harness)
})


test('failed thread receipts retain only registered codes and stages, excluding provider text and prompts', () => {
 const secret = 'never-return-private-bearer'
 const out = safeThreadFailure({ thread: { status: 'failed', error: secret, failureDetails: { code: 'run_failed', detail: 'known', providerMessage: secret, causes: [{ name: 'WorkerRefusal', code: 'secret_not_found', message: secret }, { name: secret, code: secret }] } }, chunks: [{ chunk: { type: 'data-run-stage', data: { stage: 'repository', ok: false, stderr: secret } } }, { chunk: { type: 'text-delta', delta: secret } }] }, { run_failed: ['known'] })
 assert.equal(out.code, 'run_failed'); assert.equal(out.detail, 'known'); assert.equal(out.causes[0].code, 'secret_not_found')
 assert.deepEqual(out.stages, [{ stage: 'repository', ok: false }]); assert.ok(!JSON.stringify(out).includes(secret))
})

// Published artifact and actual served control-plane build identify this run; unserved Git HEAD is metadata only.

// Repository diagnosis projects fixed classifications, never arbitrary git output.
test('repository errors retain the cause class without retaining repository credentials', () => {
 const privateValue = 'github_pat_SYNTHETIC_PRIVATE_VALUE';
 assert.deepEqual(safeRepositoryFailure('Command failed with ENOENT: git ' + privateValue), { categories: ['executable_missing'], exitCode: null });
 assert.deepEqual(safeRepositoryFailure('Command failed with exit code 128: git clone https://x-access-token:' + privateValue + '@github.com/a/b.git\nfatal: could not read Username for https://github.com: terminal prompts disabled'), { categories: ['git_authentication'], exitCode: 128 });
 const detail = safeRepositoryFailure('fatal: unable to access https://' + privateValue + ': SSL certificate problem: unable to get local issuer certificate');
 assert.deepEqual(detail.categories, ['tls_certificate']); assert.ok(!JSON.stringify(detail).includes(privateValue));
 assert.deepEqual(safeRepositoryFailure(privateValue), { categories: [], exitCode: null });
})

test('frozen-source failure matching projects locations only and never runtime text', () => {
 const out = safeSourceFailures('Run credentials unavailable. SYNTHETIC_PRIVATE_VALUE', [{source:'lib/static.ts',line:12,literal:'Run credentials unavailable.'},{source:'lib/static.ts',line:15,literal:'another fixed failure'}]);
 assert.deepEqual(out, [{source:'lib/static.ts',line:12}]); assert.ok(!JSON.stringify(out).includes('PRIVATE'));
})

// Lease diagnosis uses the frozen authority function read-only and unchanged heartbeat responses.

// Isolated stop-writer observation retains fixed query kinds/fingerprints only, never SQL or arguments.

// Compare only owner-event provenance booleans; verify enabled Manifest preparation without creating an App.

// Fixed A23 image and approved ce67 templates remain independent of the reviewed live047 quota-read optimization.

// PR1692 candidate is identified separately; it cannot claim a published main image.

test('the authorized normal source check precedes the immutable credential snapshot and a refusal cannot read a source', async () => {
  const connectionId = row.id, workspaceId = target.workspaceId, calls = [], receipt = {}
  let version = 1
  const client = { rpc: async (action,args) => {
    calls.push('ordinary-check')
    assert.equal(action,'model-order.checkModelOrderQuota')
    assert.deepEqual(args,[connectionId,workspaceId])
    version = 2 // normal production custody publishes its refreshed projection
  } }
  const result = await readCheckedSourceMetadata(client,connectionId,workspaceId,async()=>{calls.push('metadata');return {version}},receipt)
  assert.deepEqual(calls,['ordinary-check','metadata'])
  assert.equal(result.version,2);assert.equal(receipt.normalSourceCheck,true)
  await assert.rejects(readCheckedSourceMetadata({rpc:async()=>{throw Error('refused')}},connectionId,workspaceId,()=>assert.fail('no snapshot after refusal')),/refused/)
  await assert.rejects(readCheckedSourceMetadata({rpc:()=>assert.fail('invalid scope')},'invalid',workspaceId,()=>assert.fail('invalid scope')),/CHECKED_SOURCE_SCOPE/)
})

// Final receipt uses both original subscriptions on the exact formally released main image and served control plane.

test('lost computer allocation cleanup inventories only the journaled empty-instance workspace', async () => {
  const workspaceId = target.workspaceId, id = 'ownedcomputer12345'
  const Sandbox = { list: options => {
    assert.deepEqual(options.query, { metadata: { application: 'mikka', workspaceId }, state: ['running','paused'] })
    return { hasNext: false, nextItems: async () => [{ sandboxId: id, metadata: { application: 'mikka', workspaceId } }] }
  } }
  assert.deepEqual(await ownedComputerVMs(Sandbox,'synthetic-key',workspaceId),[id])
  for (const row of [{ sandboxId:id, metadata:{application:'other',workspaceId} },
    { sandboxId:id, metadata:{application:'mikka',workspaceId:rowWorkspace()} }]) {
    await assert.rejects(ownedComputerVMs({list:()=>({hasNext:false,nextItems:async()=>[row]})},'synthetic-key',workspaceId),/CLEANUP_COMPUTER_INVENTORY/)
  }
  await assert.rejects(ownedComputerVMs({list:()=>assert.fail('no provider request')},'synthetic-key','invalid'),/CLEANUP_COMPUTER_SCOPE/)
  function rowWorkspace(){return '00000000-0000-4000-8000-000000009999'}
})

// Read only the immutable 3c runtime attempt2 closed diagnostic; application secrets are not requested.


test('a lost native allocation is inventoried only by the exact Actions run and fixed native kinds', async () => {
  const runId = '42426341416', metadata = { application: 'mikka-selfhost-release', runId, kind: 'claude' }
  const row = { sandboxId: 'abcdefghijklmno', metadata }
  const Sandbox = { list(options) {
    assert.equal(options.limit, 3)
    assert.deepEqual(options.query, { metadata: { application: 'mikka-selfhost-release', runId }, state: ['running','paused'] })
    return { hasNext: false, nextItems: async () => [row] }
  } }
  assert.deepEqual(await ownedNativeVMs(Sandbox,'synthetic-key',runId),[row.sandboxId])
  for (const bad of [
    { ...row, metadata: { ...metadata, runId: '42426341417' } },
    { ...row, metadata: { ...metadata, application: 'other-application' } },
    { ...row, metadata: { ...metadata, kind: 'other-provider' } },
    { ...row, sandboxId: '../foreign' },
  ]) await assert.rejects(ownedNativeVMs({ list: () => ({ hasNext: false, nextItems: async () => [bad] }) },'synthetic-key',runId),/CLEANUP_NATIVE_INVENTORY/)
  for (const pages of [
    { hasNext: true, nextItems: async () => [row] },
    { hasNext: false, nextItems: async () => [row,row,row] },
  ]) await assert.rejects(ownedNativeVMs({ list: () => pages },'synthetic-key',runId),/CLEANUP_NATIVE_INVENTORY/)
  await assert.rejects(ownedNativeVMs({ list: () => assert.fail('no inventory without run scope') },'synthetic-key','invalid'),/CLEANUP_NATIVE_SCOPE/)
})

// Formal-source pin follows the verified no-credential final-controller preflight.

test('the shared workspace selector uses the existing normal session transport and verified callback', async () => {
  const calls = [], workspaceId = target.workspaceId
  const proof = { teamWorkspaceConfirmed: true, teamAdminMembershipVerified: true,
    teamSelectionBasis: 'unique-active-admin-identity-match', teamWorkspaceHash: 'a'.repeat(64) }
  const client = { json: async (path, options) => { calls.push({ path, options }); return { normalSession: true } } }
  const selected = await selectSharedTeam(client, 'synthetic-smoke-owner', async options => {
    assert.equal(options.ownerId, 'synthetic-smoke-owner')
    assert.deepEqual(await options.json('/mikka/api/workspace'), { normalSession: true })
    await options.json('/mikka/api/rpc', { version: 1, action: 'workspace.switchWorkspace', args: [workspaceId] })
    await options.onSelected({ workspaceId, adminId: 'private-policy-admin' })
    return proof
  })
  assert.deepEqual(selected, { workspaceId, proof })
  assert.equal(calls[0].path, '/api/workspace'); assert.equal(calls[0].options, undefined)
  assert.equal(calls[1].path, '/api/rpc'); assert.equal(calls[1].options.method, 'POST')
  assert.deepEqual(calls[1].options.headers, { 'content-type': 'application/json', 'x-mikka-rpc': '1' })
  assert.deepEqual(JSON.parse(calls[1].options.body).args, [workspaceId])
  assert.equal(JSON.stringify(selected).includes('private-policy-admin'), false)
})
test('a claimed team proof without its verified callback or policy identity cannot start source access', async () => {
  const client = { json: async () => { throw Error('unexpected transport') } }
  const proof = { teamWorkspaceConfirmed: true, teamAdminMembershipVerified: true, teamSelectionBasis: 'unique-active-admin-identity-match' }
  await assert.rejects(() => selectSharedTeam(client, 'synthetic-smoke-owner', async () => proof), /COMMUNITY_TEAM_SCOPE/)
  for (const bad of [{ ...proof, teamWorkspaceConfirmed: false }, { ...proof, teamAdminMembershipVerified: false }, { ...proof, teamSelectionBasis: 'first-visible-team' }]) {
    await assert.rejects(() => selectSharedTeam(client, 'synthetic-smoke-owner', async options => {
      await options.onSelected({ workspaceId: target.workspaceId }); return bad
    }), /COMMUNITY_TEAM_SCOPE/)
  }
})

// Final-source checkpoint after the shared-team selector stage.


test('both actual community cron ticks require persistence and no cloud collector; reports omit raw data', async () => {
  const secret = 'sensitive-cron-fixture-value-32-characters'
  const requests = []
  const request = async (url, init) => {
    requests.push(url)
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.authorization, 'Bearer ' + secret)
    assert.equal(init.method, 'GET')
    return new Response(JSON.stringify({ databaseAvailable: true, persisted: true, notificationStatus: 'not_configured',
      egress: { status: 'not_applicable' }, privateIncident: 'sensitive-incident-fixture' }),
    { status: 200, headers: { 'cache-control': 'no-store' } })
  }
  const receipt = await inspectCommunityMonitoring('https://owned.trycloudflare.com', secret, request)
  assert.equal(receipt.status, 'passed'); assert.equal(requests.length, 2)
  assert.deepEqual(requests, Array(2).fill('https://owned.trycloudflare.com/mikka/api/cron/ops-monitor'))
  for (const value of [secret, 'sensitive-incident-fixture', 'https://owned']) assert.equal(JSON.stringify(receipt).includes(value), false)
  let count = 0
  const failed = await inspectCommunityMonitoring('https://owned.trycloudflare.com', secret, async () => {
    count++
    return new Response(JSON.stringify({ databaseAvailable: true, persisted: count === 1,
      notificationStatus: 'not_configured', egress: { status: count === 1 ? 'not_applicable' : 'failed' } }),
    { status: count === 1 ? 200 : 503, headers: { 'cache-control': 'no-store' } })
  })
  assert.equal(count, 2); assert.equal(failed.status, 'failed'); assert.equal(failed.ticks[1].httpStatus, 503)
})
test('cron probe refuses unrelated, insecure or credential-bearing origins before any request', async () => {
  let called = false
  for (const origin of ['https://app.aspectlylabs.com', 'http://owned.trycloudflare.com',
    'https://user:secret@owned.trycloudflare.com', 'https://owned.trycloudflare.com/private',
    'https://owned.trycloudflare.com?token=private']) {
    await assert.rejects(inspectCommunityMonitoring(origin, 'x'.repeat(32), async () => { called = true }), /MONITOR_SCOPE/)
  }
  assert.equal(called, false)
})


test('an existing read-only handoff discovery can select the same official App for normal manager verification', () => {
  assert.equal(selectOfficialInstallation([{fullName:'alexj11324/Mikka-handoff',installationId:'12345'}]),'12345')
})


test('installation discovery refuses foreign, ambiguous, malformed and absent repositories', () => {
  for (const rows of [undefined, [], [{fullName:'foreign/Mikka-handoff',installationId:'12345'}],
    [{fullName:'alexj11324/Mikka-handoff',installationId:'12345'},{fullName:'alexj11324/Mikka-handoff',installationId:'23456'}],
    [{fullName:'alexj11324/Mikka-handoff',installationId:'secret-or-url'}]])
    assert.throws(()=>selectOfficialInstallation(rows),/GITHUB_INSTALLATION/)
  assert.equal(selectOfficialInstallation([{fullName:'alexj11324/Mikka-handoff',installationId:'12345'},
    {fullName:'alexj11324/Mikka',installationId:'23456'}]),'23456')
})

test('API CLI delivery pins independent released image and public service without claiming source equivalence', () => {
  const image='1'.repeat(40),publicRevision='2'.repeat(40)
  const comparison={status:'ahead',behind_by:0,merge_base_commit:{sha:image},files:[{filename:'lib/coordinator/store.ts',status:'modified'}]}
  assert.throws(()=>communityReleaseCompatibility(image,publicRevision,comparison),/RELEASE_DIFF/)
  const result=communityReleaseCompatibility(image,publicRevision,comparison,'native-delivery')
  assert.equal(result.kind,'independent_published_application_and_image')
  assert.equal(result.sourceEquivalenceClaimed,false)
  for (const patch of [{status:'diverged'},{behind_by:1},{merge_base_commit:{sha:publicRevision}}])
    assert.throws(()=>communityReleaseCompatibility(image,publicRevision,{...comparison,...patch},'native-delivery'),/RELEASE_ANCESTRY/)
  assert.throws(()=>communityReleaseCompatibility(image,publicRevision,comparison,'arbitrary'),/ACCEPTANCE_MODE/)
})


test('native delivery cannot allocate after its finite admission deadline', () => {
  const env={MIKKA_COMMUNITY_MODE:'native-delivery',MIKKA_COMMUNITY_ADMISSION_DEADLINE:'2026-11-09T04:30:00Z'}
  assert.doesNotThrow(()=>assertCommunityAdmission(env,Date.parse('2026-11-09T04:29:59Z')))
  assert.throws(()=>assertCommunityAdmission(env,Date.parse('2026-11-09T04:30:01Z')),/ADMISSION_EXPIRED/)
  assert.throws(()=>assertCommunityAdmission({...env,MIKKA_COMMUNITY_ADMISSION_DEADLINE:undefined}),/ADMISSION_EXPIRED/)
})
