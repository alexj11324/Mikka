import assert from 'node:assert/strict'
import test from 'node:test'
import { aliasInstance, previewAlias, previewRequest, previewSuffix, reviewScope } from './review-access.mjs'

test('a lease label resolves only to its existing instance and is never reused', () => {
  const id = 'a17e'.repeat(16), first=previewAlias(id), next=previewAlias(id)
  assert.notEqual(first, next)
  assert.equal(first.length, 63)
  assert.equal(aliasInstance(first), id)
  assert.equal(aliasInstance(first.slice(0,-1)+'b'), null)
  assert.equal(aliasInstance(first+'.another'), null)
  assert.equal(previewSuffix({TASK_PREVIEW_DOMAIN:'preview.example.test'}), 'preview.example.test')
  assert.equal(previewSuffix({TASK_PREVIEW_DOMAIN:'https://example.test'}), null)
})
test('proxy keeps browser security signals and only the isolated session', async () => {
  const origin='https://fixture.preview.example.test', session='__Host-mikka_preview='+'A'.repeat(43)
  const headers={cookie:'parent=fixture; '+session,authorization:'Bearer fixture','x-api-key':'fixture','cf-access-jwt-assertion':'fixture',
    'sec-fetch-site':'cross-site','sec-fetch-dest':'iframe','sec-fetch-mode':'navigate','service-worker':'script'}
  const input=new Request(origin+'/path',{method:'POST',headers,body:'body'})
  const forwarded=previewRequest(input,origin)
  assert.equal(forwarded.headers.get('cookie'),session)
  for(const name of ['authorization','x-api-key','cf-access-jwt-assertion']) assert.equal(forwarded.headers.get(name),null)
  for(const name of ['sec-fetch-site','sec-fetch-dest','sec-fetch-mode','service-worker']) assert.equal(forwarded.headers.get(name),headers[name])
  assert.equal(forwarded.headers.get('host'),new URL(origin).hostname)
  assert.equal(forwarded.redirect,'manual')
  assert.equal(await forwarded.text(),'body')
  assert.throws(()=>previewRequest(new Request('https://elsewhere.test/'),origin))
  assert.equal(previewRequest(new Request(origin,{headers:{cookie:session+'; '+session}}),origin).headers.get('cookie'),null)
  const socket=previewRequest(new Request(origin+'/hmr',{headers:{upgrade:'websocket','sec-websocket-protocol':'vite-hmr'}}),origin)
  assert.equal(socket.headers.get('connection'),'Upgrade')
  assert.equal(socket.headers.get('sec-websocket-protocol'),'vite-hmr')
})
test('a human lease only admits a matching scoped checkout for its original five-minute interval',()=>{
  const id=crypto.randomUUID(), now=Date.now()
  const value={leaseId:id, deviceId:crypto.randomUUID(),repoId:crypto.randomUUID(),sourceOperationId:crypto.randomUUID(),
    bindingId:'a'.repeat(64),epoch:7,kind:'terminal',expiresAt:now+30_000,worktreePath:'/workspace/worktrees/task'}
  assert.deepEqual(reviewScope(value,now),value)
  for(const overrides of [{sourceOperationId:'x'},{kind:'shell'},{epoch:-1},{expiresAt:now},{expiresAt:now+300001},
    {worktreePath:'/workspace/worktrees/../other'},{worktreePath:'/workspace/worktrees/a//b'}])
    assert.throws(()=>reviewScope({...value,...overrides},now))
})
