import { Pool } from 'pg'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
const pool=new Pool({connectionString:process.env.E2E_DATABASE_URL,max:1,statement_timeout:4000})
const qa=process.env.E_CODEX_QA!
const write=(sample:any)=>appendFileSync(join(qa,'pg-waits.jsonl'),JSON.stringify({at:new Date().toISOString(),sample})+'\n',{mode:0o600})
let stopped=false
process.once('SIGTERM',()=>{stopped=true})
try{
 while(!stopped){
 const {rows}=await pool.query(`SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers,
  floor(extract(epoch FROM clock_timestamp()-xact_start))::int AS xact_seconds,left(query,140) AS query
  FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle'
  AND (wait_event_type='Lock' OR xact_start < now()-interval '4 seconds')`)
 const sanitized=rows.map(({query,...x})=>({...x,command:query.trim().split(/\s+/,1)[0].toUpperCase().replace(/[^A-Z]/g,'').slice(0,12),relations:[...new Set(query.toLowerCase().match(/agent_runs|thread_queued_messages|factory_tasks|factory_attempts|mikka_workspace_members|mikka_workspaces|device_tokens|coordinator_events|issue_versions|issues|pg_advisory_xact_lock/g)??[])]}))
 if(sanitized.length)write(sanitized)
 await new Promise(r=>setTimeout(r,2000))
 }
}finally{await pool.end()}
