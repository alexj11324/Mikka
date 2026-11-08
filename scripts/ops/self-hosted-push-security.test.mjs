import test from 'node:test'
import assert from 'node:assert/strict'
import { senderDeploymentGate } from './self-hosted-push-security.mjs'
const variables = [{key:'EXPO_ACCESS_TOKEN',target:['production'],type:'sensitive',createdAt:100,updatedAt:150}]
const deployment = {id:'owned',target:'production',readyState:'READY',createdAt:151,meta:{githubCommitSha:'exact'}}
test('sender must be present in a ready deployment newer than its configuration', () => {
  assert.equal(senderDeploymentGate({variables,deployment,source:'exact'}).sensitiveSender,true)
  assert.throws(()=>senderDeploymentGate({variables,deployment:{...deployment,createdAt:149},source:'exact'}),/SENDER_NOT_YET_DEPLOYED/)
})
test('wrong source or incomplete publication cannot activate security', () => {
  assert.throws(()=>senderDeploymentGate({variables,deployment,source:'other'}),/DEPLOYMENT_SOURCE/)
  assert.throws(()=>senderDeploymentGate({variables,deployment:{...deployment,readyState:'BUILDING'},source:'exact'}),/DEPLOYMENT_SOURCE/)
})
test('missing, ambiguous, preview-only or plaintext senders fail closed', () => {
  for(const input of [[],[...variables,...variables],[{...variables[0],target:['preview']}],[{...variables[0],type:'plain'}]])
    assert.throws(()=>senderDeploymentGate({variables:input,deployment,source:'exact'}),/SENDER_CONFIGURATION/)
})
test('unknown timestamps cannot establish the cutover barrier', () => {
  assert.throws(()=>senderDeploymentGate({variables:[{...variables[0],createdAt:null,updatedAt:null}],deployment,source:'exact'}),/SENDER_TIME_UNKNOWN/)
})
