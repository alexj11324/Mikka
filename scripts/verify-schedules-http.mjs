import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Pool } from 'pg'
const origin=process.env.SCHEDULE_HTTP_ORIGIN ?? 'http://127.0.0.1:3179'
const database=process.env.SCHEDULE_TEST_DATABASE_URL
if(new URL(origin).hostname!=='127.0.0.1'||!database||new URL(database).hostname!=='127.0.0.1'||!/179|schedule/.test(new URL(database).pathname))throw new Error('Only isolated loopback acceptance is allowed')
const secret=process.env.SCHEDULE_TEST_AUTH_SECRET
const cron=process.env.SCHEDULE_TEST_CRON_SECRET
if(!secret||!cron)throw new Error('Synthetic test secrets required')
const pool=new Pool({connectionString:database})
const workspace=randomUUID(),bot=randomUUID(),source=randomUUID(),owner=`http179-${randomUUID()}`,other=`http179-${randomUUID()}`
const stamp=()=>new Date().toISOString()
async function identity(id){
 const token=randomUUID()
 await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',[id,`${id}@example.invalid`])
 await pool.query('INSERT INTO session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',[randomUUID(),token,id])
 return `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac('sha256',secret).update(token).digest('base64')}`)}`
}
const ownerCookie=await identity(owner),otherCookie=await identity(other)
async function request(path,{cookie=ownerCookie,method='GET',body,headers={}}={}){
 const response=await fetch(`${origin}/mikka${path}`,{method,headers:{...(cookie?{cookie,origin}:{}),...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})})
 const result=await response.json()
 return {status:response.status,body:result}
}
const context={workspaceId:workspace,conversation:'bot',sessionId:bot,sourceId:source}
const command=(cmd,cookie)=>request('/api/schedules',{method:'POST',cookie,body:{...context,command:cmd}})
const definition=(timing)=>({title:'179 real Next controlled reminder',timezone:'Etc/UTC',timing,task:{kind:'reminder',text:'Controlled local result; no external message'},misfire:'catch_up_once',maxLatenessMinutes:5})
async function sweep(){const result=await request('/api/cron/runtime',{cookie:null,headers:{authorization:`Bearer ${cron}`}});assert.equal(result.status,200);return result.body}
async function waitUntil(at){const delay=at-Date.now();if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay))}
try{
 assert.equal((await request('/api/auth/get-session')).body.user.id,owner)
 await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'179 HTTP workspace\')',[workspace,owner])
 for(const id of [owner,other])await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,\'member\')',[workspace,id,`${id}@example.invalid`])
 await pool.query('INSERT INTO agent_sessions(id,"userId",title) VALUES($1,$2,\'179 original HTTP Bot chat\')',[bot,owner])
 await pool.query('INSERT INTO agent_turns(id,"sessionId","userId",prompt,status,"attemptId") VALUES($1,$2,$3,\'Controlled scheduled reminder request\',\'complete\',$1)',[source,bot,owner])
 console.log(JSON.stringify({at:stamp(),phase:'authenticated real Next/PG',owner,workspace,bot,source}))
 assert.equal((await request('/api/cron/runtime',{cookie:null})).status,401)
 assert.equal((await command({action:'list'},null)).status,401)
 const start=Date.now()+2500
 const created=await command({action:'create',requestId:randomUUID(),definition:definition({kind:'once',at:new Date(start).toISOString()})})
 assert.equal(created.status,200)
 const schedule=created.body.schedule
 assert.equal((await command({action:'history',scheduleId:schedule.id},otherCookie)).status,403) // other cannot use owner's private source conversation
 console.log(JSON.stringify({at:stamp(),phase:'created before service restart',scheduleId:schedule.id,dueAt:schedule.next_at,slaMs:10000}))
 execFileSync('docker',['restart','mikka179-next'],{stdio:'ignore'})
 for(let attempt=0;attempt<40;attempt++){
  try{if((await request('/api/auth/get-session')).status===200)break}catch{}
  await new Promise(resolve=>setTimeout(resolve,250))
 }
 assert.ok((await command({action:'list'})).body.schedules.some(row=>row.id===schedule.id))
 await waitUntil(start+50)
 await Promise.all(Array.from({length:10},()=>sweep()))
 const first=(await command({action:'history',scheduleId:schedule.id})).body.occurrences
 assert.equal(first.length,1);assert.equal(first[0].status,'succeeded');assert.ok(Date.now()-start<10000)
 const chat=await request(`/api/agent/sessions?sessionId=${bot}`)
 assert.ok(chat.body.turns.some(turn=>turn.id===first[0].operation_id&&turn.completion.includes('succeeded')))
 console.log(JSON.stringify({at:stamp(),phase:'once survived real Next restart and 10 concurrent HTTP sweeps',scheduleId:schedule.id,occurrenceId:first[0].id,operationId:first[0].operation_id,resultVisibleInOriginalChat:true}))
 const repeatedAt=Date.now()+1000
 const recurring=(await command({action:'create',requestId:randomUUID(),definition:definition({kind:'interval',start:new Date(repeatedAt).toISOString(),minutes:1})})).body.schedule
 await waitUntil(repeatedAt+50);await sweep()
 console.log(JSON.stringify({at:stamp(),phase:'first recurring occurrence finished; next due in 60 seconds',scheduleId:recurring.id}))
 for(let i=0;i<6;i++){await waitUntil(repeatedAt+(i+1)*10000);console.log(JSON.stringify({at:stamp(),phase:'real-time wait heartbeat',elapsedSeconds:(i+1)*10}))}
 await sweep()
 const history=(await command({action:'history',scheduleId:recurring.id})).body.occurrences
 assert.equal(history.length,2);assert.ok(history.every(row=>row.status==='succeeded'))
 const paused=(await command({action:'pause',scheduleId:recurring.id,version:1})).body.schedule
 assert.equal(paused.status,'paused')
 const updated=(await command({action:'update',scheduleId:recurring.id,version:paused.version,definition:{...recurring.definition,timezone:'Asia/Shanghai',timing:{kind:'interval',start:new Date(Date.now()+60000).toISOString(),minutes:1}}})).body.schedule
 assert.equal(updated.status,'paused');assert.equal(updated.definition.timezone,'Asia/Shanghai')
 const resumed=(await command({action:'resume',scheduleId:recurring.id,version:updated.version})).body.schedule
 assert.equal(resumed.status,'active')
 const cancelled=await command({action:'cancel',scheduleId:recurring.id,version:resumed.version})
 assert.equal(cancelled.body.schedule.status,'cancelled');await sweep()
 console.log(JSON.stringify({at:stamp(),phase:'two real-time recurring results; persistent update/pause/resume/cancel',scheduleId:recurring.id,occurrences:history.map(row=>({occurrenceId:row.id,operationId:row.operation_id,status:row.status,dueAt:row.due_at,finishedAt:row.finished_at}))}))
 // A model-key-free environment must expose the actual remaining chat gate.
 const agent=await fetch(`${origin}/mikka/api/agent`,{method:'POST',headers:{cookie:ownerCookie,origin,'content-type':'application/json'},body:JSON.stringify({prompt:'Remind me tomorrow morning',sessionId:bot,turnId:randomUUID()})})
 assert.equal(agent.status,503)
 console.log(JSON.stringify({at:stamp(),phase:'real model conversation acceptance blocked',httpStatus:agent.status,reason:'No provider credential/model resource enabled in this isolated environment; HTTP tool management success is not model-chat acceptance.'}))
 console.log(JSON.stringify({at:stamp(),result:'PASS isolated Next/PG lifecycle; ISSUE REMAINS OPEN',retained:{owner,workspace,bot,source}}))
}finally{await pool.end()}
