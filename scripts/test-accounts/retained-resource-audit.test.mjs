import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { retainedAuditMatches } from './retained-resource-audit.mjs'

test('retaining immutable audit requires the exact record, table and unchanged bytes', () => {
  const value = { id: 'synthetic-audit', ownerId: 'owner', resourceKind: 'thread', action: 'delete' }
  const row = { value, text: JSON.stringify(value) }
  const receipts = new Map([['resource_access_events:synthetic-audit',createHash('sha256').update(row.text).digest('hex')]])
  assert.equal(retainedAuditMatches('resource_access_events',row,receipts),true)
  assert.equal(retainedAuditMatches('workspace_audit_events',row,receipts),false,'ordinary business audit is not a retained source receipt')
  assert.equal(retainedAuditMatches('resource_access_events',{value:{...value,id:'other-lease'},text:row.text},receipts),false)
  assert.equal(retainedAuditMatches('resource_access_events',{value,text:JSON.stringify({...value,action:'grant_insert'})},receipts),false)
  assert.equal(retainedAuditMatches('resource_access_events',row,new Map()),false)
})

test('run disclosure retention includes the exact attempt', () => {
  const value = {runId:'synthetic-run',attempt:1,personalResources:true}
  const row = {value,text:JSON.stringify(value)}
  const receipts = new Map([['run_resource_disclosures:synthetic-run:1',createHash('sha256').update(row.text).digest('hex')]])
  assert.equal(retainedAuditMatches('run_resource_disclosures',row,receipts),true)
  assert.equal(retainedAuditMatches('run_resource_disclosures',{value:{...value,attempt:2},text:row.text},receipts),false)
})
