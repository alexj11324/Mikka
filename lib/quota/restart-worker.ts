import { Pool } from 'pg'
import { QuotaStore } from './store'
async function main() {
const pool=new Pool({connectionString:process.env.QUOTA_TEST_DATABASE_URL,max:2})
const owner=process.env.QUOTA_TEST_OWNER!,key=process.env.QUOTA_TEST_KEY!
const store=new QuotaStore(pool,async (owner,workspace)=>Boolean((await pool.query('SELECT 1 FROM quota_test_members WHERE owner_id=$1 AND workspace_id=$2 AND active',[owner,workspace])).rowCount))
const r=await store.reserve({ownerId:owner,key,resource:'agent.turn',binding:{}})
if (process.env.QUOTA_TEST_PHASE === 'claim-cas') {
  await store.activateBound(owner, r.id, async client => {
    await client.query(`UPDATE quota_test_claims SET status='preparing',quota_id=$2 WHERE id=$1 AND status='queued'`, [key,r.id])
    console.log('READY')
    await new Promise(() => {})
  })
} else await store.activate(owner,r.id)
if(process.env.QUOTA_TEST_PHASE==='after-send') {
  const response=await fetch(process.env.QUOTA_TEST_EFFECT_URL!)
  if(!response.ok)throw new Error('Effect failed')
  await response.text()
}
console.log('READY')
await new Promise(()=>{})

}
void main().catch(error => { console.error(error); process.exitCode = 1 })
