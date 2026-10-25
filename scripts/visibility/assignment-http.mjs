// Real Next Server Actions over HTTP and retained PostgreSQL fixtures; no UI mocks.
import assert from 'node:assert/strict'
import {randomUUID,randomBytes} from 'node:crypto'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {Pool} from 'pg'
const origin=new URL(process.env.E2E_BASE_URL),appURL=new URL(process.env.E2E_DATABASE_URL),wsURL=new URL(process.env.VISIBILITY_WORKSPACE_DATABASE_URL)
for(const u of [appURL,wsURL])assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.pathname.endsWith('_e2e'))
assert.notEqual(appURL.toString(),wsURL.toString());assert.ok(['localhost','127.0.0.1'].includes(origin.hostname))
const manifest=JSON.parse(readFileSync(process.env.NEXT_SERVER_REFERENCE_MANIFEST??'.next/server/server-reference-manifest.json','utf8'))
const actionId=name=>{const row=Object.entries(manifest.node).find(([,v])=>v.filename==='app/actions/issue-metadata.ts'&&v.exportedName===name);assert.ok(row,'built action manifest entry required');return row[0]}
const app=new Pool({connectionString:appURL.toString()}),ws=new Pool({connectionString:wsURL.toString()}),id=()=>randomUUID()
const evidence={sha:process.env.GITHUB_SHA??null,startedAt:new Date().toISOString(),environment:'built Next Server Actions HTTP + two isolated PG databases; no UI interaction claim',checks:[]}
async function signup(){
 const response=await fetch(new URL('/mikka/api/auth/sign-up/email',origin),{method:'POST',headers:{origin:origin.origin,'content-type':'application/json'},body:JSON.stringify({name:'Synthetic assignment fixture',email:'assignment-'+id()+'@example.invalid',password:randomBytes(32).toString('hex')})})
 assert.equal(response.status,200);const data=await response.json();const cookie=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');assert.ok(cookie);return {id:data.user.id,cookie}
}
function flight(text){
 const rows=new Map()
 for(const line of text.split('\n')){const p=line.indexOf(':');if(p<0)continue;const key=line.slice(0,p),body=line.slice(p+1);try{rows.set(key,body.startsWith('E')?{flightError:true}:JSON.parse(body))}catch{}}
 const seen=new Set()
 function resolve(v){
  if(typeof v==='string'&&/^\$(?:@)?[0-9a-f]+$/.test(v)){const k=v.replace(/^\$@?/,'');if(seen.has(k))throw Error('cyclic fixture response');seen.add(k);const value=resolve(rows.get(k));seen.delete(k);return value}
  if(Array.isArray(v))return v.map(resolve)
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x)]))
  return v
 }
 const root=rows.get('0');return resolve(root?.a??'$1')
}
async function action(actor,name,args){
 const r=await fetch(new URL('/mikka/en/settings/members',origin),{signal:AbortSignal.timeout(20000),redirect:'manual',method:'POST',headers:{origin:origin.origin,cookie:actor.cookie+'; NEXT_LOCALE=en','accept-language':'en','Next-Action':actionId(name),'content-type':'application/json',accept:'text/x-component'},body:JSON.stringify(args)})
 if(r.status>=300&&r.status<400)throw new Error('Unexpected action redirect: '+r.status+' '+r.headers.get('location'))
 return {status:r.status,value:flight(await r.text())}
}
async function options(actor,issue){const r=await action(actor,'getIssuePropertyOptions',[issue]);assert.equal(r.status,200);assert.ok(r.value&&!r.value.flightError);return r.value}
async function state(issue){return(await app.query('SELECT revision,content FROM issues WHERE id=$1',[issue])).rows[0]}
async function submit(actor,issue,patch){const before=await state(issue);const r=await action(actor,'updateIssueMetadata',[{id:issue,revision:before.revision,patch}]);assert.equal(r.status,200);return {before,result:r.value,after:await state(issue)}}
try{
 const owner=await signup(),member=await signup(),outsider=await signup(),w1=id(),w2=id(),team=id(),issue=id(),ownerAgent=id(),memberAgent=id(),foreignAgent=id()
 for(const [w,u]of [[w1,owner.id],[w2,outsider.id]])await ws.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Retained assignment fixture\')',[w,u])
 for(const [w,u]of [[w1,owner.id],[w1,member.id],[w2,outsider.id]])await ws.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')',[w,u,u+'@example.invalid'])
 await ws.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Assignment fixture\',\'ASM\')',[team,w1,owner.id])
 await app.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Synthetic assignment task\',\'{"type":"doc","content":[]}\',\'todo\',\'normal\',\'workspace\')',[issue,owner.id])
 await ws.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',[issue,team,w1,owner.id])
 await app.query('INSERT INTO issue_members("issueId","userId","memberId") VALUES($1,$2,$3)',[issue,owner.id,member.id])
 for(const [a,u,name]of [[ownerAgent,owner.id,'Owner private Agent'],[memberAgent,member.id,'Member own Agent'],[foreignAgent,outsider.id,'Foreign private Agent']])await app.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',$3)',[a,u,name])
 const own=await options(owner,issue),shared=await options(member,issue)
 assert.deepEqual(own.agents.map(a=>a.id),[ownerAgent]);assert.equal(own.capabilities.canAssignAgent,true)
 assert.deepEqual(shared.agents,[]);assert.equal(shared.capabilities.canAssignAgent,false);assert.ok(!JSON.stringify(shared).includes('Owner private Agent'))
 const positive=await submit(owner,issue,{assignee:{kind:'agent',id:own.agents[0].id}})
 assert.ok(positive.result.issue);assert.equal(positive.after.revision,positive.before.revision+1)
 assert.equal(positive.result.issue.metadata.assignee.id,ownerAgent)
 for(const [actor,agent]of [[member,memberAgent],[member,ownerAgent],[owner,foreignAgent],[outsider,foreignAgent]]){
  const denied=await submit(actor,issue,{assignee:{kind:'agent',id:agent}})
  assert.ok(denied.result.error);assert.deepEqual(denied.after,denied.before)
 }
 const edit=await submit(member,issue,{labels:[{name:'Member editable label',color:'blue'}]});assert.ok(edit.result.issue)
 evidence.checks.push('real property-options action: owner option submits and persists; member options empty/capability false; member own/owner Agent and foreign Agent submissions refused without revision/content change; member label edit still works')
 await ws.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[w1,member.id])
 const revokedOptions=await action(member,'getIssuePropertyOptions',[issue]);assert.ok(revokedOptions.status>=400||revokedOptions.value?.flightError)
 const revoked=await submit(member,issue,{labels:[{name:'must not save',color:'blue'}]});assert.ok(revoked.result.error);assert.deepEqual(revoked.after,revoked.before)
 const foreignOptions=await action(outsider,'getIssuePropertyOptions',[issue]);assert.ok(foreignOptions.status>=400||foreignOptions.value?.flightError)
 await app.query('UPDATE issues SET scope=\'personal\' WHERE id=$1',[issue]);await ws.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',[w1,member.id])
 const personalOptions=await action(member,'getIssuePropertyOptions',[issue]);assert.ok(personalOptions.status>=400||personalOptions.value?.flightError)
 const personal=await submit(member,issue,{assignee:{kind:'agent',id:memberAgent}});assert.ok(personal.result.error);assert.deepEqual(personal.after,personal.before)
 evidence.checks.push('fresh HTTP options and writes refuse revoked/foreign workspace users and personal task with stale membership; all rejected writes preserve PG state')
 evidence.finishedAt=new Date().toISOString();mkdirSync('test-results/visibility',{recursive:true});writeFileSync('test-results/visibility/assignment-evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
}finally{await app.end();await ws.end()}
