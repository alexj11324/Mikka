import assert from 'node:assert/strict'
import test from 'node:test'
import { accept, scopeHashes, target } from './task-attachment-production.mjs'

const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), ATTACHMENT_EXPECTED_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1',
  SMOKE_OWNER_EMAIL: 'qa+mikka-smoke@example.invalid', SMOKE_OWNER_PASSWORD: 'dummy password' }
const owner = 'local-test-owner', workspace = 'local-test-team', original = 'local-original'
const historicalScope = scopeHashes(owner, workspace)
const theCase = target(env).fixture
const source = 'e4494a3c8620d0ac8fe4cd885144a3f47be0252c'
const list = '/api/tasks/' + theCase.id + '/attachments'
const marker = '案例 ' + theCase.caseId + '，发布源 ' + source + '。'
const other = { id: 'unrelated', name: 'keep private original', size: 1, bytes: Buffer.from('x') }
function fixture(opts = {}) {
  const rows = new Map([[other.id, other]]), calls = []
  let versionReads = 0, team = original, signedIn = false
  const issue = { id: theCase.id, userId: owner, workspaceId: workspace, ownershipState: 'bound',
    title: '测试 1593 lifecycle review ' + theCase.caseId + ' ' + theCase.harness,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: marker }] }] } }
  const client = {
    clear() {},
    async request(path, init = {}) {
      const method = init.method ?? 'GET'
      calls.push({ method, path })
      if (path === '/api/auth/sign-in/email') { signedIn = true; return new Response('{}') }
      if (path === '/api/auth/sign-out') { signedIn = Boolean(opts.stuckSession); return new Response('{}') }
      assert.ok(path.startsWith(list + '?id='))
      const id = path.slice(list.length + 4)
      assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/)
      if (method === 'POST') {
        const file = init.body.get('file')
        const row = { id, name: file.name, size: file.size, bytes: Buffer.from(await file.arrayBuffer()) }
        if (opts.conflict) { rows.set(id, { ...row, bytes: Buffer.alloc(file.size) }); return new Response(null, { status: 409 }) }
        assert.equal(rows.has(id), false)
        rows.set(id, row)
        if (opts.lostPost) throw new Error('secret response body')
        return Response.json({ id, name: row.name, size: row.size })
      }
      if (method === 'DELETE') {
        assert.notEqual(id, other.id)
        if (opts.refuseDelete) return new Response(null, { status: 500 })
        rows.delete(id)
        if (opts.lostDelete) throw new Error('secret response body')
        return new Response(null, { status: 204 })
      }
      assert.equal(method, 'GET')
      if (!rows.has(id)) return new Response(null, { status: 404 })
      const { name, bytes } = rows.get(id)
      return new Response(opts.badBytes ? Buffer.alloc(bytes.length) : bytes, { headers: {
        'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
        'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name) } })
    },
    async json(path) {
      calls.push({ method: 'GET', path })
      if (path === '/api/version') {
        versionReads++
        return { build: versionReads === opts.badBuildAt ? '0'.repeat(40) : env.GITHUB_SHA }
      }
      if (path.startsWith('/api/auth/get-session')) return signedIn ? { user: { email: env.SMOKE_OWNER_EMAIL, id: opts.wrongOwner ? 'stranger' : owner } } : null
      if (path === '/api/workspace') return { currentUserId: owner, workspace: { id: team } }
      assert.equal(path, list)
      return { canEdit: !opts.readOnly, files: [...rows.values()].map(({ id, name, size }) => ({ id, name, size })) }
    },
    async rpc(action, args) {
      calls.push({ method: 'RPC', path: action })
      if (action === 'workspace.switchWorkspace') { assert.deepEqual(args, [original]); team = original; return { workspaceId: original } }
      assert.equal(action, 'issues.getIssue'); assert.deepEqual(args, [theCase.id])
      return { issue }
    },
  }
  const execute = overrides => accept({ client, env: { ...env, ...overrides }, historicalScope, selectTeam: async (_, context, remember) => {
    assert.equal(context.ownerId, owner); remember(original); team = workspace
    return { workspaceId: opts.wrongTeam ? 'other-team' : workspace }
  } })
  return { execute, rows, calls, issue }
}
const productWrites = f => f.calls.filter(c => ['POST', 'DELETE'].includes(c.method) && c.path.startsWith(list))
test('live revision, owner, team, retained task and exact uploaded bytes pass; unrelated file untouched', async () => {
  const f = fixture(), r = await f.execute()
  assert.equal(r.status, 'passed'); assert.equal(r.bytesMatched, true); assert.equal(r.fileCleanup, 'confirmed_absent')
  assert.equal(r.workspaceRestored, true); assert.equal(r.signedOut, true); assert.equal(r.finalBuildMatched, true)
  assert.deepEqual(productWrites(f).map(v => v.method), ['POST','DELETE'])
  assert.equal(productWrites(f)[0].path, productWrites(f)[1].path)
  assert.deepEqual([...f.rows.values()], [other])
  const serialized = JSON.stringify(r)
  for (const privateValue of [env.SMOKE_OWNER_EMAIL, env.SMOKE_OWNER_PASSWORD, theCase.id, theCase.caseId,
    theCase.harness, f.issue.title, other.name, original, marker, productWrites(f)[0].path.split('=').at(-1)]) assert.ok(!serialized.includes(privateValue))
})
test('a branch, PR, dispatch, wrong repository, stale SHA or invalid run refuses before any request', async () => {
  for (const invalid of [{ GITHUB_REF: 'refs/heads/topic' }, { GITHUB_EVENT_NAME:'pull_request' }, { GITHUB_EVENT_NAME:'workflow_dispatch' },
    { GITHUB_REPOSITORY: 'other/Mikka' }, { ATTACHMENT_EXPECTED_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ID:'0' }, { GITHUB_RUN_ATTEMPT:'x' }]) {
    const f = fixture(), r = await f.execute(invalid); assert.equal(r.failure,'target_refused'); assert.equal(f.calls.length, 0)
  }
})
test('version drift before login, before upload and after cleanup each reject without losing cleanup', async () => {
  for (const n of [1,2,3]) {
    const f = fixture({ badBuildAt:n }), r = await f.execute()
    assert.equal(r.status,'failed'); assert.deepEqual([...f.rows.values()], [other])
    assert.equal(productWrites(f).length,n===3 ? 2 : 0)
    if(n===1) assert.ok(!f.calls.some(c=>c.path.includes('sign-in')))
    if(n===3) assert.equal(r.finalBuildMatched,false)
  }
})
test('wrong normal actor/team and read-only lists do not modify any file', async () => {
  for(const opts of [{wrongOwner:true},{wrongTeam:true},{readOnly:true}]) {
    const f=fixture(opts), r=await f.execute(); assert.equal(r.status,'failed'); assert.equal(productWrites(f).length,0)
  }
})
test('a successful sign-out response with a remaining active session never passes', async () => {
  const f = fixture({ stuckSession: true }), r = await f.execute()
  assert.equal(r.signedOut, false)
  assert.equal(r.status, 'failed')
  assert.equal(r.fileCleanup, 'confirmed_absent')
  assert.deepEqual(r.cleanupFailures, ['sign_out'])
})
test('fixed task ID, creator, workspace, bound state, exact title and original content marker are required', async () => {
  for (const change of [{ id:'other' },{ userId:'other' },{ workspaceId:'other' },{ ownershipState:'unknown' },
    { title:'edited' },{ content:{type:'doc',attrs:{mikka:{deletedAt:'today'}},content:[]} },
    { content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:theCase.caseId}]}]} }]) {
    const f=fixture(); Object.assign(f.issue,change); const r=await f.execute()
    assert.equal(r.failure,'task_mismatch'); assert.equal(productWrites(f).length,0)
  }
})
test('lost upload response reconciles its own data and cleans without a second upload or false PASS', async () => {
  const f=fixture({lostPost:true}), r=await f.execute()
  assert.equal(r.status,'failed'); assert.equal(r.fileCleanup,'confirmed_absent'); assert.deepEqual([...f.rows.values()],[other])
  assert.doesNotMatch(JSON.stringify(r),/secret response body/)
})
test('lost delete response proves absence by rereading original URL and list', async () => {
  const f=fixture({lostDelete:true}), r=await f.execute()
  assert.equal(r.status,'passed'); assert.deepEqual(productWrites(f).map(x=>x.method),['POST','DELETE'])
})
test('conflict or ambiguous upload with mismatching bytes never authorizes deleting an unknown attachment', async () => {
  for(const opts of [{conflict:true},{badBytes:true,lostPost:true}]) {
    const f=fixture(opts); const r=await f.execute()
    assert.equal(r.status,'failed'); assert.deepEqual(productWrites(f).map(x=>x.method),['POST']); assert.equal(f.rows.size,2)
    if(opts.conflict) {
      const retry=await f.execute({GITHUB_RUN_ATTEMPT:'2'})
      assert.equal(retry.status,'failed'); assert.deepEqual(productWrites(f).map(x=>x.method),['POST']); assert.equal(f.rows.size,2)
    }
  }
})
test('confirmed creation followed by bad storage bytes still removes the exact upload without passing', async () => {
  const f = fixture({ badBytes: true }), r = await f.execute()
  assert.equal(r.status, 'failed')
  assert.equal(r.bytesMatched, false)
  assert.equal(r.fileCleanup, 'confirmed_absent')
  assert.deepEqual(r.cleanupFailures, [])
  assert.deepEqual(productWrites(f).map(x => x.method), ['POST', 'DELETE'])
  assert.deepEqual([...f.rows.values()], [other])
})
test('a retry recovers pending upload, then a repeat round trip uses exactly the same ID and final state', async () => {
  const opts={refuseDelete:true}, f=fixture(opts)
  let r=await f.execute(); assert.equal(r.fileCleanup,'unconfirmed'); assert.equal(r.status,'failed')
  assert.deepEqual(r.cleanupFailures, ['attachment'])
  opts.refuseDelete=false
  r=await f.execute({GITHUB_RUN_ATTEMPT:'2'}); assert.equal(r.status,'passed'); assert.equal(f.rows.size,1)
  assert.equal(productWrites(f).filter(v=>v.method==='POST').length,1)
  r=await f.execute({GITHUB_RUN_ATTEMPT:'3'}); assert.equal(r.status,'passed')
  const writes = productWrites(f)
  assert.equal(writes.filter(v => v.method === 'POST').length, 2)
  assert.equal(new Set(writes.map(v => v.path)).size, 1)
  assert.deepEqual([...f.rows.values()], [other])
})
test('a rerun can finish after an initial pre-write failure', async () => {
  const options = { badBuildAt: 2 }, f = fixture(options)
  const failed = await f.execute()
  assert.equal(failed.status, 'failed')
  assert.equal(productWrites(f).length, 0)
  delete options.badBuildAt
  const retry = await f.execute({ GITHUB_RUN_ATTEMPT: '2' })
  assert.equal(retry.status, 'passed')
  assert.deepEqual(productWrites(f).map(v => v.method), ['POST', 'DELETE'])
  assert.deepEqual([...f.rows.values()], [other])
})
