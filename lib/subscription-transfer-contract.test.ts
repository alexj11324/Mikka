import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSubscriptionTransferApproval } from './subscription-transfer-contract'
const now = Date.now()
const actor = { ownerId:'owner',workspaceId:'20000000-0000-4000-8000-000000000001',databaseIdentity:'a'.repeat(64),origin:'https://app.aspectlylabs.com' }
const common = {origin:'https://app.infisical.com',projectId:'89850d6a-f020-4936-863e-df77380dfe40'}
const approval = {sourcePrincipal:'operator:'+ 'd'.repeat(64),transferId:'20000000-0000-4000-8000-000000000002',enrollmentId:'20000000-0000-4000-8000-000000000003',ownerId:actor.ownerId,workspaceId:actor.workspaceId,provider:'claude',providerSubject:'provider-different-email',source:{...common,environment:'staging',grantPath:'/byos/pending-grants'},destination:{...common,environment:'prod',grantPath:'/byos/grants'},destinationOrigin:actor.origin,destinationDatabaseIdentity:actor.databaseIdentity,sourceDigest:'b'.repeat(64),sourceRevision:1,expiresAt:new Date(now+600000).toISOString(),deleteSource:false}
test('transfer approval binds source and production target without equating provider identity to app email',()=>assert.equal(validateSubscriptionTransferApproval(approval,actor,now).providerSubject,'provider-different-email'))
test('wrong owner, workspace, database, origin, expired and broadened approval fail closed',()=>{
 for(const a of [{...actor,ownerId:'other'},{...actor,workspaceId:'other'},{...actor,databaseIdentity:'c'.repeat(64)},{...actor,origin:'https://evil.invalid'}]) assert.throws(()=>validateSubscriptionTransferApproval(approval,a,now))
 for(const change of [{expiresAt:new Date(now-1).toISOString()},{expiresAt:new Date(now+3600000).toISOString()},{deleteSource:true},{token:'must-not-be-accepted'},{source:{...approval.source,origin:'https://us.infisical.com'}},{destination:{...approval.destination,environment:'staging'}}]) assert.throws(()=>validateSubscriptionTransferApproval({...approval,...change},actor,now))
})
