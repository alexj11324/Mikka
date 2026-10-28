import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

function reader(rows:unknown[][]) {
  let index=0, writes=0
  const executor={
    select() {
      const result=rows[index++] ?? []
      const chain={from:()=>chain,innerJoin:()=>chain,where:()=>chain,for:async()=>result,limit:async()=>result}
      return chain
    },
    insert() {writes++;throw new Error('unexpected insert')},
    update() {writes++;throw new Error('unexpected update')},
  }
  return {executor,get writes(){return writes},get reads(){return index}}
}
const globals=globalThis as typeof globalThis & {linearTargetProbe:{tx:unknown}}
globals.linearTargetProbe={tx:null}
const issue={id:randomUUID(),userId:'owner',scope:'workspace',linearSyncBlocked:false,scopeVersion:2,content:{type:'doc',content:[]}}

test('unlinked workspace has no fallback to an active account team',async()=>{
  const fake=reader([[issue],[]]);globals.linearTargetProbe.tx=fake.executor
  const {reserveLinearPublication,LinearTargetNotVerifiedError}=await import('../lib/linear-sync/publication')
  await assert.rejects(reserveLinearPublication(issue.id),LinearTargetNotVerifiedError)
  assert.equal(fake.reads,2);assert.equal(fake.writes,0)
})

test('a verified link keeps its own target and an existing publication',async()=>{
  const publication={id:randomUUID(),issueId:issue.id,ownerId:issue.userId,teamSyncId:randomUUID(),scopeVersion:2,linearIssueId:randomUUID(),retiredAt:null}
  const team={id:publication.teamSyncId,ownerId:issue.userId,active:true}
  const link={id:randomUUID(),issueId:issue.id,ownerId:issue.userId,teamSyncId:team.id,linearIssueId:publication.linearIssueId,publicationId:publication.id,externalTargetVerified:true,remoteRemovedAt:null}
  const fake=reader([[issue],[{link,team}],[publication],[]]);globals.linearTargetProbe.tx=fake.executor
  const {reserveLinearPublication}=await import('../lib/linear-sync/publication')
  const result=await reserveLinearPublication(issue.id)
  assert.ok(result);assert.equal(result.team.id,team.id);assert.equal(result.publication.linearIssueId,link.linearIssueId);assert.equal(fake.writes,0)
})

test('an in-flight publication is retired if its verified link disappears',async()=>{
  const fake=reader([[{id:issue.id}],[]])
  const {requireCurrentPublication,RetiredPublicationError}=await import('../lib/linear-sync/publication')
  const snapshot={issue,publication:{id:randomUUID(),scopeVersion:2,linearIssueId:randomUUID()},fence:undefined} as unknown as Parameters<typeof requireCurrentPublication>[0]
  await assert.rejects(requireCurrentPublication(snapshot,fake.executor as unknown as Parameters<typeof requireCurrentPublication>[1]),RetiredPublicationError)
})
