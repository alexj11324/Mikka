/** Keyless disposable PG fixtures. Never imported by product runtime. */
import {randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import {PolicyStore} from '../policy/store'
import {policySigner} from '../policy/signing'
import {AGENT_ROUTE} from '../policy/model'
import type {ModelRoute,PolicyDocument} from '../policy/contract'
export const fixtureSigner=()=>policySigner('isolated-resource-proof-no-production-authorization-123456789')
export const fixtureResources={ 'coordinator.model':{units:2,unknownCostApproved:true},'coordinator.compact':{units:2,unknownCostApproved:true},'gateway.decision':{units:2,unknownCostApproved:true},'schedule.model':{units:2,unknownCostApproved:true},'web.search':{units:1,unknownCostApproved:true},'web.scrape':{units:1,unknownCostApproved:true} }
export async function resourceFixture(app:Pool,workspace:Pool,routes:ModelRoute[]=[AGENT_ROUTE],managed=true){
 const owner=`resources-${randomUUID()}`,workspaceId=randomUUID(),operationId=randomUUID()
 await app.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',[owner,`${owner}@example.invalid`])
 await workspace.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'isolated resource proof\')',[workspaceId,owner])
 await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,\'admin\')',[workspaceId,owner,`${owner}@example.invalid`])
 await app.query(`INSERT INTO quota_allocations(workspace_id,max_budget_units,max_concurrency,max_rate_limit,rate_window_seconds,resources,expires_at,granted_by,reason) VALUES($1,10000,20,1000,60,$2,clock_timestamp()+interval '1 day','isolated-fixture','nonproduction controlled transport only')`,[workspaceId,fixtureResources])
 await app.query(`INSERT INTO quota_tenants(workspace_id,window_start,window_end,budget_units,concurrency_limit,rate_limit,rate_window_seconds,resources) VALUES($1,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '12 hours',10000,20,1000,60,$2)`,[workspaceId,fixtureResources])
 await app.query('INSERT INTO quota_owners(owner_id,workspace_id) VALUES($1,$2)',[owner,workspaceId])
 const document:PolicyDocument={schemaVersion:1,state:'enforce',offlineTtlSeconds:60,layers:[{scope:'workspace',id:workspaceId,ceiling:{git_push:'deny'},models:routes}]}
 const policy=new PolicyStore(workspace,fixtureSigner())
 if(managed)await policy.publish(workspaceId,owner,0,document)
 return {owner,workspaceId,operationId,policy,document}
}
export function isolatedResourceUrls(){
 const app=process.env.RESOURCE_APP_TEST_URL,workspace=process.env.RESOURCE_WORKSPACE_TEST_URL
 if(!app||!workspace||[app,workspace].some(x=>new URL(x).hostname!=='127.0.0.1'||!new URL(x).pathname.endsWith('_176'))||['VERCEL','AI_GATEWAY_API_KEY','DECISION_GATEWAY_API_KEY','OPENCODE_API_KEY','COMPOSIO_API_KEY','OPENAI_API_KEY'].some(k=>process.env[k]))throw new Error('isolated keyless resource databases required')
 return {app,workspace}
}
