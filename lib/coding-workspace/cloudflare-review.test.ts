import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import test from 'node:test'
import {cloudflareReview, readReviewCheckpoint} from './cloudflare-review'
import {terminalFixture} from './terminal/test-fixture'

test('a human grant contains only the scoped review lease and expected checkout',()=>{
  const original=terminalFixture().scope, instance='a'.repeat(64), repositoryKey='v2/github.com/mikka-ci/task'
  const proof={instanceId:instance,id:randomUUID(),sha256:'b'.repeat(64)}
  const authority={...original,nativeExitedProof:true,sandboxId:instance,sponsoredPlacement:{operationId:randomUUID(),repositoryKey,checkpoint:proof}}
  const lease={id:randomUUID(),expiresAt:new Date(Date.now()+45_000).toISOString(),reviewOperationId:randomUUID(),reviewKind:'terminal' as const}
  const review=cloudflareReview(authority,lease,'terminal')
  assert.equal(review.grant.operationId,lease.reviewOperationId)
  assert.equal(review.scope.sourceOperationId,authority.sponsoredPlacement.operationId)
  assert.equal(review.grant.repositoryKey,repositoryKey)
  assert.deepEqual(review.grant.requiredCheckpoint,proof)
  assert.equal(review.scope.leaseId,lease.id)
  assert.equal('credential' in review.grant,false)
  assert.equal('deviceTokenId' in review.scope,false)
  assert.throws(()=>cloudflareReview(authority,lease,'preview'))
  assert.throws(()=>cloudflareReview({...authority,nativeExitedProof:false},lease,'terminal'))
  assert.throws(()=>cloudflareReview(authority,{...lease,expiresAt:new Date(0).toISOString()},'terminal'))
  assert.equal(readReviewCheckpoint(proof,'c'.repeat(64)),undefined)
})
