// Real Next Server Actions over HTTP and retained PostgreSQL fixtures; no UI mocks.
import assert from 'node:assert/strict'
import {randomUUID,randomBytes} from 'node:crypto'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {Pool} from 'pg'
const origin=new URL(process.env.E2E_BASE_URL),appURL=new URL(process.env.E2E_DATABASE_URL),wsURL=new URL(process.env.VISIBILITY_WORKSPACE_DATABASE_URL)
for(const u of [appURL,wsURL])assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.pathname.endsWith('_e2e'))
assert.notEqual(appURL.toString(),wsURL.toString());assert.ok(['localhost','127.0.0.1'].includes(origin.hostname))
const manifest=JSON.parse(readFileSync(process.env.NEXT_SERVER_REFERENCE_MANIFEST??'.next/server/server-reference-manifest.json','utf8'))
const actionId=(name,file='app/actions/issue-metadata.ts')=>{const row=Object.entries(manifest.node).find(([,v])=>v.filename===file&&v.exportedName===name);assert.ok(row,'built action manifest entry required');return row[0]}
const app=new Pool({connectionString:appURL.toString()}),ws=new Pool({connectionString:wsURL.toString()}),id=()=>randomUUID()
const evidence={sha:process.env.GITHUB_SHA??null,startedAt:new Date().toISOString(),environment:'built Next Server Actions HTTP + two isolated PG databases; no UI interaction claim',checks:[]}
async function signup(){
 const body=JSON.stringify({name:'Synthetic data fixture',email:'data-'+id()+'@example.invalid',password:randomBytes(32).toString('hex')})
 const request=()=>fetch(new URL('/mikka/api/auth/sign-up/email',origin),{method:'POST',headers:{origin:origin.origin,'content-type':'application/json'},body})
 const response=await request()
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
async function action(actor,name,args,file){
 const r=await fetch(new URL('/mikka/en/settings/members',origin),{signal:AbortSignal.timeout(20000),redirect:'manual',method:'POST',headers:{origin:origin.origin,cookie:actor.cookie+'; NEXT_LOCALE=en','accept-language':'en','Next-Action':actionId(name,file),'content-type':'application/json',accept:'text/x-component'},body:JSON.stringify(args)})
 if(r.status>=300&&r.status<400)throw new Error('Unexpected action redirect: '+r.status+' '+r.headers.get('location'))
 return {status:r.status,value:flight(await r.text())}
}
async function state(issue){return(await app.query('SELECT revision,content FROM issues WHERE id=$1',[issue])).rows[0]}
async function submit(actor,issue,patch,extra={}){const before=await state(issue);const r=await action(actor,'updateIssueMetadata',[{id:issue,revision:before.revision,patch,...extra}]);assert.equal(r.status,200);return {before,result:r.value,after:await state(issue)}}
async function search(actor,workspace,params={}){
 const url=new URL('/mikka/api/issues/search',origin);url.search=new URLSearchParams({workspaceId:workspace,...params})
 const response=await fetch(url,{headers:{cookie:actor.cookie}})
 return {status:response.status,data:await response.json()}
}
// The installed auth library limits sign-up to 3 requests per 10 seconds.
// Leave its window intact when this suite follows the 3-user assignment suite.
await new Promise(resolve=>setTimeout(resolve,11000))
try{
 const owner=await signup(),member=await signup(),outsider=await signup(),w1=id(),w2=id(),team=id(),issue=id(),privateIssue=id(),agent=id()
 for(const [w,u]of [[w1,owner.id],[w2,outsider.id]])await ws.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Retained data fixture')`,[w,u])
 for(const [w,u]of [[w1,owner.id],[w1,member.id],[w2,outsider.id]])await ws.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,'member','active')`,[w,u,u+'@example.invalid'])
 await ws.query(`INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,'Data fixture','DATA')`,[team,w1,owner.id])
 const marker='search-'+id()
 const rows=await app.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope,"updatedAt") SELECT gen_random_uuid(),$1,$2||' '||g,jsonb_build_object('type','doc','attrs',jsonb_build_object('mikka',jsonb_build_object('number',g))),'todo','normal','workspace','2020-01-01T00:00:00.123000Z'::timestamptz+g*interval '1 microsecond' FROM generate_series(1,125) g RETURNING id`,[owner.id,marker])
 for(const row of rows.rows)await ws.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)`,[row.id,team,w1,owner.id])
 for(const [i,scope,title]of [[issue,'workspace','Mutable actor task'],[privateIssue,'personal',marker+' private 50%_off']]){
  await app.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,$3,'{"type":"doc","content":[]}','todo','normal',$4)`,[i,owner.id,title,scope])
  await ws.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)`,[i,team,w1,owner.id])
  await app.query(`INSERT INTO issue_members("issueId","userId","memberId") VALUES($1,$2,$3)`,[i,owner.id,member.id])
 }
 const history=async i=>(await app.query(`SELECT actor_type,actor_id FROM issue_versions WHERE "issueId"=$1 ORDER BY revision DESC LIMIT 1`,[i])).rows[0]
 for(const actor of [owner,member]){
  const r=await submit(actor,issue,{estimate:3},{actorType:'agent',actorId:agent,actor:{type:'agent',id:agent}})
  assert.ok(r.result.issue);assert.deepEqual(await history(issue),{actor_type:'user',actor_id:actor.id})
 }
 const visible=await action(member,'listIssueVersions',[issue],'app/actions/issues.ts');assert.equal(visible.status,200);assert.equal(visible.value[0].actor.id,member.id)
 const outside=await action(outsider,'listIssueVersions',[issue],'app/actions/issues.ts');assert.ok(outside.status>=400||outside.value?.flightError)
 evidence.checks.push('actual signed-in Server Actions ignore forged actor fields; owner/member PG history records caller; authorized history projects member identity and foreign viewer refuses')
 const seen=new Set();let cursor=null,pages=0
 do{
  const r=await search(member,w1,{q:marker,limit:'50',...(cursor?{cursor}:{})});assert.equal(r.status,200)
  for(const row of r.data.items){assert.ok(!seen.has(row.id));seen.add(row.id);assert.notEqual(row.id,privateIssue)}
  cursor=r.data.nextCursor;assert.ok(++pages<5)
 }while(cursor)
 assert.equal(seen.size,125);assert.equal(pages,3)
 assert.deepEqual([...seen].sort(),rows.rows.map(r=>r.id).sort())
 assert.equal((await search(owner,w1,{q:'50%_off'})).data.items.some(r=>r.id===privateIssue),true)
 assert.equal((await search(member,w1,{q:"%' OR 1=1 --"})).data.items.length,0)
 for(const params of [{limit:'51'},{q:'x'},{cursor:'invalid'},{workspaceId:'invalid'},{excludeDescendants:'true'}])assert.equal((await search(member,w1,params)).status,400)
 assert.equal((await search(member,w1,{excludeId:privateIssue,excludeDescendants:'true'})).status,404)
 assert.equal((await search(outsider,w1,{q:marker})).status,403)
 assert.equal((await search(outsider,w2,{q:marker})).data.items.length,0)
 evidence.checks.push('actual GET search paginates 125 authorized rows in three pages with microsecond timestamps, no duplicates/hidden private row; escaped wildcard literal, injection text, bounded params and hidden anchor tested; foreign workspace denied')
 await ws.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,[w1,member.id])
 assert.equal((await search(member,w1,{q:marker})).status,403)
 const denied=await submit(member,issue,{estimate:9},{actorId:owner.id});assert.ok(denied.result.error);assert.deepEqual(denied.before,denied.after)
 const revoked=await action(member,'listIssueVersions',[issue],'app/actions/issues.ts');assert.ok(revoked.status>=400||revoked.value?.flightError)
 assert.deepEqual(await history(issue),{actor_type:'user',actor_id:member.id})
 evidence.checks.push('revoked membership refuses fresh HTTP search/history and forged metadata write without issue/history mutation; all fixtures retained')
 evidence.finishedAt=new Date().toISOString();mkdirSync('test-results/data',{recursive:true});writeFileSync('test-results/data/http-evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
}finally{await app.end();await ws.end()}
