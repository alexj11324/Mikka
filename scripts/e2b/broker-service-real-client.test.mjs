// Real PostgreSQL, AES-GCM, broker service and CDP; only KMS is synthetic.
// Runs only against the explicit loopback test DB and synthetic HTTPS page.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { fillCredential } from '../../lib/credentials/broker.ts'
import { CredentialStore } from '../../lib/credentials/store.ts'
import { seal } from '../../lib/credentials/kms.ts'
import { recordCredentialAction } from '../../lib/cloud-computer/credential-action-ledger.ts'
let [url, targetId, origin, loaderId, node, passwordNode, submitNode] = process.argv.slice(2)
const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL
assert(['127.0.0.1','localhost'].includes(new URL(databaseURL).hostname))
assert.equal(new URL(origin).hostname, '127.0.0.1')
const schema = `broker_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: databaseURL })
await admin.query(`CREATE SCHEMA ${schema}`)
const database = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
const checkedQuery = target => async (...args) => {
  try { return await target.query(...args) }
  catch (error) { console.error('Synthetic fixture SQL failure', error.code, error.message); throw error }
}
const pool = { query: checkedQuery(database), async connect() { const client=await database.connect(); return { query: checkedQuery(client), release: () => client.release() } }, end: () => database.end() }
try {
  await pool.query(`CREATE TABLE bots(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid);
    CREATE TABLE bot_subagents(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"botId" uuid,status text,epoch int,"targetId" text,"runPolicy" jsonb,step text,needs jsonb,task text DEFAULT 'Synthetic login fixture');
    CREATE TABLE subagent_events("ownerId" text,"workspaceId" uuid,"botId" uuid,"subagentId" uuid,event jsonb);
    CREATE TABLE cloud_machines("workspaceId" uuid,"ownerId" text,state text,"sandboxId" text);
    CREATE TABLE workspace_computer_policies("workspaceId" uuid PRIMARY KEY,permission text,version int);
    CREATE TABLE pending_actions(id uuid PRIMARY KEY,"userId" text,action text,input jsonb,status text,context jsonb,"createdAt" timestamptz DEFAULT now());
    CREATE TABLE credentials(id uuid PRIMARY KEY,user_id text,origin text,username text,revoked_at timestamptz,unattended_allowed boolean DEFAULT true,last_used_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE credential_secrets(credential_id uuid,wrapped_dek text,nonce text,ciphertext text);
    CREATE TABLE browser_sessions(credential_id uuid PRIMARY KEY,wrapped_dek text,nonce text,ciphertext text,expires_at timestamptz);
    CREATE TABLE credential_fill_leases(nonce_hash text PRIMARY KEY,credential_id uuid,user_id text,workspace_id uuid,bot_id uuid,subagent_id uuid,run_id uuid,origin text,target jsonb,expires_at timestamptz,consumed_at timestamptz,input_kind text DEFAULT 'password',input_envelope jsonb);
    CREATE TABLE credential_access_events(credential_id uuid,user_id text,bot_id uuid,run_id uuid,subagent_id uuid,origin_seen text,decision text)`)
  const caller = { userId:'synthetic-owner', workspaceId:randomUUID(), botId:randomUUID(), subagentId:randomUUID() }
  const credentialId = randomUUID(), key = randomBytes(32)
  let decrypts = 0
  const kms = { async generate(){ return { plaintext: Buffer.from(key), wrapped:'synthetic-only' } }, async decrypt(){ decrypts++; return Buffer.from(key) } }
  const policy = { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, computer_use:'allow' } }
  await pool.query('INSERT INTO bots VALUES ($1,$2,$3)',[caller.botId,caller.userId,caller.workspaceId])
  await pool.query('INSERT INTO bot_subagents(id,"ownerId","workspaceId","botId",status,epoch,"targetId","runPolicy") VALUES ($1,$2,$3,$4,\'running\',1,$5,$6)',[caller.subagentId,caller.userId,caller.workspaceId,caller.botId,targetId,policy])
  await pool.query('INSERT INTO cloud_machines VALUES ($1,$2,\'running\',\'synthetic-sandbox\')',[caller.workspaceId,caller.userId])
  await pool.query('INSERT INTO workspace_computer_policies VALUES ($1,\'allow\',1)',[caller.workspaceId])
  await pool.query('INSERT INTO credentials(id,user_id,origin,username) VALUES ($1,$2,$3,\'synthetic-user\')',[credentialId,caller.userId,origin])
  const encrypted = await seal(kms,{userId:caller.userId,credentialId,origin},Buffer.from(JSON.stringify({username:'synthetic-user',password:'synthetic-password'})))
  await pool.query('INSERT INTO credential_secrets VALUES ($1,$2,$3,$4)',[credentialId,encrypted.wrappedDek,encrypted.nonce,encrypted.ciphertext])
  const binding = { ...caller,runId:caller.subagentId,epoch:1,policyVersion:1,targetId,origin,loaderId,backendNodeId:Number(node),role:'username',expiresAt:Date.now()+60000, ...(passwordNode ? { additionalInput:{backendNodeId:Number(passwordNode),role:'password'}, submitNodeId:Number(submitNode) } : {}) }
  const store = new CredentialStore(pool,kms)
  let released = false
  const guard = { async begin(){ return {cdpUrl:url,targetId,guardToken:new URL(url).searchParams.get('guard')} }, async end(_target,guardToken){
    if (!passwordNode) throw Error('Inserted input must remain guarded')
    const endpoint = new URL(url);endpoint.protocol=endpoint.protocol==='wss:'?'https:':'http:';endpoint.pathname=endpoint.pathname.replace(/cdp$/,'end');endpoint.searchParams.delete('guard')
    const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({guardToken})})
    assert.equal(response.status,200);released=true
  } }
  async function leaseFor(decision='allow') {
    const {action} = await recordCredentialAction(pool,binding,decision,false,randomUUID())
    const target = {targetId,origin,sandboxId:'synthetic-sandbox',endpoint:'https://synthetic.e2b.app/',expiresAt:Date.now()+60000,observedInput:{loaderId,backendNodeId:Number(node),credentialRole:'username',epoch:1,permissionVersion:1,...(binding.additionalInput ? {additionalInput:binding.additionalInput,submitNodeId:binding.submitNodeId} : {})},credentialAction:action}
    const lease = await store.lease(caller,origin,target)
    assert.equal(lease.status,'ready')
    return lease.lease
  }
  const lease = await leaseFor()
  if (passwordNode) {
    assert.deepEqual(await fillCredential(pool,lease,{kms,guard}),{status:'submitted',origin})
    assert.equal(released,true)
    const saved=(await pool.query('SELECT ciphertext FROM browser_sessions WHERE credential_id=$1',[credentialId])).rows
    assert.equal(saved.length,1)
    assert(saved[0].ciphertext.length>0)
    await assert.rejects(fillCredential(pool,lease,{kms,guard}))
    // Keep the synthetic KMS key in this process while the outer fixture
    // clears its browser cookies and supplies a newly observed document.
    console.log('READY: captured encrypted session')
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    const fresh = JSON.parse(input)
    url = fresh.url; loaderId = fresh.loaderId; node = String(fresh.node)
    Object.assign(binding, { loaderId, backendNodeId:Number(node), additionalInput:{backendNodeId:fresh.passwordNode,role:'password'}, submitNodeId:fresh.submitNode })
    released = false
    const reuse = await leaseFor()
    assert.deepEqual(await fillCredential(pool,reuse,{kms,guard}),{status:'session_applied',origin})
    assert.equal(released,true)
    assert.equal(decrypts,3,'one password open, one session seal, one cached-session open')
    console.log(`PASS: real PG and broker service filled model-selected fields, submitted selected form, sealed and restored the session after browser-cookie removal, and released actual gateway; retained schema ${schema}; KMS synthetic`)
  } else {
  assert.deepEqual(await fillCredential(pool,lease,{kms,guard}),{status:'guarded',origin})
  assert.equal(decrypts,1)
  await assert.rejects(fillCredential(pool,lease,{kms,guard}))
  const pending = await leaseFor('ask')
  await assert.rejects(fillCredential(pool,pending,{kms,guard}))
  assert.equal(decrypts,1,'pending approval must not decrypt')
  const stale = await leaseFor()
  await pool.query('UPDATE workspace_computer_policies SET version=2 WHERE "workspaceId"=$1',[caller.workspaceId])
  await assert.rejects(fillCredential(pool,stale,{kms,guard}))
  assert.equal(decrypts,1,'policy version change must not decrypt')
  const stopped = await leaseFor()
  await pool.query('UPDATE workspace_computer_policies SET version=1 WHERE "workspaceId"=$1',[caller.workspaceId])
  await pool.query('UPDATE bot_subagents SET status=\'stopped\' WHERE id=$1',[caller.subagentId])
  await assert.rejects(fillCredential(pool,stopped,{kms,guard}))
  assert.equal(decrypts,1,'STOP must not decrypt')
  await pool.query('UPDATE bot_subagents SET status=\'running\' WHERE id=$1',[caller.subagentId])
  const readonly = await leaseFor()
  await pool.query('UPDATE bot_subagents SET "runPolicy"=$2 WHERE id=$1',[caller.subagentId,{...policy,readOnly:true}])
  await assert.rejects(fillCredential(pool,readonly,{kms,guard}))
  assert.equal(decrypts,1,'read-only snapshot must not decrypt')
  await pool.query('UPDATE bot_subagents SET "runPolicy"=$2 WHERE id=$1',[caller.subagentId,policy])
  const replaced = await leaseFor()
  await pool.query('UPDATE cloud_machines SET "sandboxId"=\'replacement\'')
  await assert.rejects(fillCredential(pool,replaced,{kms,guard}))
  assert.equal(decrypts,1,'replaced machine must not decrypt')
  await pool.query('UPDATE cloud_machines SET "sandboxId"=\'synthetic-sandbox\'')
  const unknownPolicy = await leaseFor()
  await pool.query('UPDATE workspace_computer_policies SET permission=\'unknown\'')
  await assert.rejects(fillCredential(pool,unknownPolicy,{kms,guard}))
  assert.equal(decrypts,1,'invalid policy must not decrypt')
  await pool.query('UPDATE workspace_computer_policies SET permission=\'allow\'')
  const wrongReview = await leaseFor('ask')
  await pool.query('UPDATE pending_actions SET status=\'running\' WHERE status=\'pending\'')
  await pool.query('UPDATE bot_subagents SET status=\'needs_you\',needs=$1',[{kind:'approval',actionId:randomUUID()}])
  await assert.rejects(fillCredential(pool,wrongReview,{kms,guard}))
  assert.equal(decrypts,1,'a different current review must not decrypt')
  const approved = await leaseFor('ask')
  const exactReview = (await pool.query('SELECT input FROM pending_actions WHERE status=\'pending\'')).rows[0].input
  await pool.query('UPDATE bot_subagents SET needs=$1',[{kind:'approval',actionId:exactReview.actionId}])
  await pool.query('UPDATE pending_actions SET status=\'running\' WHERE id=$1 AND status=\'pending\'',[exactReview.actionId])
  assert.deepEqual(await fillCredential(pool,approved,{kms,guard}),{status:'guarded',origin})
  assert.equal(decrypts,2,'only the exact existing approved action may decrypt')
  console.log(`PASS: real PG and broker service + actual CDP insertion; replay/pending/stale-policy/STOP denied; retained schema ${schema}; KMS synthetic`)
  }
  key.fill(0)
} finally {
  await pool.end();await admin.end()
}
