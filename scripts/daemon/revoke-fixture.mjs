// Called only by the retained-fixture Go/PG integration test. No HTTP auth substitute.
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { revokeDeviceCredential } from '../../lib/device-revocation.ts'
const url=new URL(process.env.E2E_DATABASE_URL)
assert.equal(process.env.MIKKA_DATABASE_URL,url.toString())
assert.equal(url.hostname,'127.0.0.1');assert.ok(url.pathname.endsWith('_e2e'))
let input='';for await(const chunk of process.stdin)input+=chunk
const {owner,tokenId}=JSON.parse(input), db=new Pool({connectionString:url.toString()})
try{const result=await revokeDeviceCredential(db,owner,tokenId);assert.ok(result);console.log('synthetic credential revoked with audit')}finally{await db.end()}
