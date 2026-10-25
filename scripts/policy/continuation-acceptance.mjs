import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

/** Requires the parent's exact reviewed audit SQL overlay, never rewrites that
 * migration here. Uses only the caller's synthetic loopback fixtures. */
export async function continuationPolicyAcceptance({app,workspace,owner,userId,deviceId,repoId,agentId,workspaceId,teamId,deviceHeaders,anonymous,receipts}) {
  const auditRepairSha=process.env.POLICY_AUDIT_REPAIR_SHA
  assert.match(auditRepairSha??'',/^[a-f0-9]{40}$/,'explicit reviewed audit dependency SHA is required')
  const other=randomUUID(), otherTeam=randomUUID(), issue=randomUUID(), root=randomUUID(), child=randomUUID()
  await workspace.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Synthetic unmanaged continuation destination')`,[other,userId])
  await workspace.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'Synthetic','continuation@example.invalid','admin')`,[other,userId])
  await workspace.query(`INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,'Synthetic','CONT')`,[otherTeam,other,userId])
  await app.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,'Synthetic continuation policy regression','{"type":"doc","content":[]}','todo','normal','workspace')`,[issue,userId])
  await workspace.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)`,[issue,teamId,workspaceId,userId])
  const tx=await app.connect()
  try {
    await tx.query('BEGIN')
    await tx.query(`SELECT set_config('mikka.audit_workspace',$1,true)`,[workspaceId])
    await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt) VALUES($1,$2,$3,$4,$5,$6,'done','Synthetic root')`,[root,userId,issue,agentId,deviceId,repoId])
    await tx.query('COMMIT')
  } catch(error) {await tx.query('ROLLBACK');throw error} finally {tx.release()}
  // Continuation is an ordinary run with no mailbox and no retryOf.
  await app.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"continuesRunId") VALUES($1,$2,$3,$4,$5,$6,'queued','Synthetic child',$7)`,[child,userId,issue,agentId,deviceId,repoId,root])
  const captured=(await app.query(`SELECT resource,tenant FROM security_audit_resource_scopes WHERE source='agent_runs' AND resource=ANY($1::text[]) ORDER BY resource`,[[root,child]])).rows
  assert.equal(captured.length,2);assert.ok(captured.every(r=>r.tenant===workspaceId),'audit dependency must preserve original workspace on continuation')
  await workspace.query(`UPDATE mikka_team_issues SET "teamId"=$1,"workspaceId"=$2 WHERE "issueId"=$3`,[otherTeam,other,issue])
  assert.equal((await owner.call(`/api/policy?workspaceId=${other}`)).body.signed,null)
  const response=await anonymous.call(`/v1/devices/${deviceId}/runs/${child}/claim`,'POST',{},deviceHeaders)
  assert.equal(response.status,403);assert.equal(response.body.error,'policyScopeMismatch')
  assert.equal((await app.query(`SELECT status FROM agent_runs WHERE id=$1`,[child])).rows[0].status,'queued')
  assert.equal((await app.query(`SELECT count(*)::int count FROM run_tokens WHERE "runId"=$1`,[child])).rows[0].count,0)
  receipts.push({utc:new Date().toISOString(),probe:'ordinary continuation moved A to unmanaged B cannot bypass captured A policy',status:response.status,expected:'policyScopeMismatch'})
  const historical=randomUUID(), retry=randomUUID(), question=randomUUID()
  // Old ordinary runs without a trusted organization capture can legitimately
  // have personal projections. Neither resume representation proves that past.
  await app.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status) VALUES($1,$2,$3,$4,$5,$6,'done')`,[historical,userId,issue,agentId,deviceId,repoId])
  await app.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"continuesRunId") VALUES($1,$2,$3,$4,$5,$6,'queued',$7)`,[retry,userId,issue,agentId,deviceId,repoId,historical])
  await app.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"questionContinuation") VALUES($1,$2,$3,$4,$5,$6,'queued',$7)`,[question,userId,issue,agentId,deviceId,repoId,{originRunId:historical}])
  for(const candidate of [retry,question]) {
    const denied=await anonymous.call(`/v1/devices/${deviceId}/runs/${candidate}/claim`,'POST',{},deviceHeaders)
    assert.equal(denied.status,403);assert.equal(denied.body.error,'policyScopeUnverified')
    assert.equal((await app.query(`SELECT status FROM agent_runs WHERE id=$1`,[candidate])).rows[0].status,'queued')
    assert.equal((await app.query(`SELECT count(*)::int count FROM run_tokens WHERE "runId"=$1`,[candidate])).rows[0].count,0)
  }
  return {auditRepairSha,captured,childStatus:'queued',issuedRunTokens:0,unverifiedHistory:['ordinary continuation: denied','questionContinuation without continuesRunId: denied'],policyResult:'policyScopeMismatch',isolation:'test overlay only; not final combined source/production acceptance'}
}
