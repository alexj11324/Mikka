import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

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
const issue={id:randomUUID(),userId:'owner',workspaceId:randomUUID(),ownershipState:'bound',scope:'workspace',linearSyncPolicy:'explicit',linearSyncBlocked:false,scopeVersion:2,content:{type:'doc',content:[]}}
const dialect = new PgDialect()
const workspace = { select: () => {
  const chain = { from: () => chain, innerJoin: () => chain, where: (condition: SQL) => {
    const query = dialect.sqlToQuery(condition)
    assert.ok(query.params.includes(issue.workspaceId)); assert.ok(query.params.includes(issue.userId)); assert.ok(query.params.includes('active'))
    return { orderBy: async () => [{ id: issue.workspaceId, kind: 'team' }] }
  } }
  return chain
} }
const globals=globalThis as typeof globalThis & {linearTargetProbe:{tx:unknown;workspace:typeof workspace}}
globals.linearTargetProbe={tx:null,workspace}

test('unlinked workspace has no fallback to an active account team',async()=>{
  const fake=reader([[issue],[]]);globals.linearTargetProbe.tx=fake.executor
  const {reserveLinearPublication,LinearTargetNotVerifiedError}=await import('../lib/linear-sync/publication')
  await assert.rejects(reserveLinearPublication(issue.id),LinearTargetNotVerifiedError)
  assert.equal(fake.reads,2);assert.equal(fake.writes,0)
})

test('a verified link keeps its own target and an existing publication',async()=>{
  const publication={id:randomUUID(),issueId:issue.id,ownerId:issue.userId,teamSyncId:randomUUID(),scopeVersion:2,linearIssueId:randomUUID(),retiredAt:null}
  const team={id:publication.teamSyncId,ownerId:issue.userId,workspaceId:issue.workspaceId,active:true}
  const link={id:randomUUID(),issueId:issue.id,ownerId:issue.userId,teamSyncId:team.id,linearIssueId:publication.linearIssueId,publicationId:publication.id,externalTargetVerified:true,remoteRemovedAt:null}
  const fake=reader([[issue],[{link,team}],[publication],[]]);globals.linearTargetProbe.tx=fake.executor
  const {reserveLinearPublication}=await import('../lib/linear-sync/publication')
  const result=await reserveLinearPublication(issue.id)
  assert.ok(result);assert.equal(result.team.id,team.id);assert.equal(result.publication.linearIssueId,link.linearIssueId);assert.equal(fake.writes,0)
})

test('an in-flight publication is retired if its verified link disappears',async()=>{
  const fake=reader([[{id:issue.id}],[]])
  const {requireCurrentPublication,RetiredPublicationError}=await import('../lib/linear-sync/publication')
  const team={id:randomUUID(),workspaceId:issue.workspaceId,ownerId:issue.userId}
  const snapshot={issue,team,publication:{id:randomUUID(),scopeVersion:2,linearIssueId:randomUUID(),teamSyncId:team.id},fence:undefined} as unknown as Parameters<typeof requireCurrentPublication>[0]
  await assert.rejects(requireCurrentPublication(snapshot,fake.executor as unknown as Parameters<typeof requireCurrentPublication>[1]),RetiredPublicationError)
  assert.equal(fake.reads,2);assert.equal(fake.writes,0)
})
