// Process-death regression helper; refuses every target except the isolated fixture.
import { Pool } from 'pg'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { ScheduleStore } from './store.ts'
const target=process.env.E2E_DATABASE_URL
if(!isE2eTarget(target)||target!==process.env.DATABASE_URL||target!==process.env.MIKKA_DATABASE_URL)throw new Error('Isolated schedule fixture required')
const pool=new Pool({connectionString:target,max:1})
const store=new ScheduleStore(pool,async(_owner,_workspace,work)=>work(),async()=>null,async()=>{},()=>true,()=>new Date(process.env.SCHEDULE_TEST_CLOCK!))
console.log(JSON.stringify(await store.claim()))
setInterval(()=>{},1000)
