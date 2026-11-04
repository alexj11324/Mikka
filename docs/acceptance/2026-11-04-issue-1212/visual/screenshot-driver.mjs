import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
const originalLog=console.log
console.log=(text)=>{writeFileSync('/tmp/mikka-1220-visual-result.json',text+'\n'); originalLog(text)}
import readline from 'node:readline'
import { Pool } from 'pg'
import { chromium } from '@playwright/test'
import { loadEnvironment, assertDeploymentIdentity } from '../../scripts/test-accounts/environment.mjs'
import { TestAccountPool } from '../../scripts/test-accounts/pool.mjs'
import { acquireTestAccounts, auditEvidence } from '../../scripts/test-accounts/session.mjs'

const environment = await loadEnvironment()
await assertDeploymentIdentity(environment)
const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 3 })
const pool = new TestAccountPool(db, environment)
await pool.prepare({ pairs: 2 })
const scope = await acquireTestAccounts({ database: db, environment, runId: 'pr1220-visual-'+randomUUID(), workerId: 'owner-review', requestId: randomUUID(), ttlMs:300000 })
const fixture = { issueId:randomUUID(), sourceId:randomUUID(), taskId:randomUUID(), attemptId:randomUUID(), candidateId:randomUUID(), producerId:randomUUID(), versionId:randomUUID() }
for(const [type,id] of [['issues',fixture.issueId],['issue_versions',fixture.versionId]]) await scope.recordResource({type,id,ownerId:scope.owner.userId})
const tx=await db.connect()
try{
 await tx.query('BEGIN')
 const content={type:'doc',attrs:{mikka:{number:1220}},content:[{type:'paragraph',content:[{type:'text',text:'Local visual fixture / 本地视觉检查：Factory live subscriptions, owner/workspace scope, one refresh per key.'}]}]}
 await tx.query('INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,$3,$4,\'todo\',\'normal\')',[fixture.issueId,scope.owner.userId,'Factory live · 实时验收通知',JSON.stringify(content)])
 await tx.query('INSERT INTO issue_versions (id,"issueId","userId",revision,title,content,status,priority) VALUES($1,$2,$3,1,$4,$5,\'todo\',\'normal\')',[fixture.versionId,fixture.issueId,scope.owner.userId,'Factory live · 实时验收通知',JSON.stringify(content)])
 await tx.query('INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload,"issueId","deliveredAt") VALUES($1,$2,\'user_message\',$3,$4,$5,now())',[fixture.sourceId,scope.owner.userId,'pr1220-visual:'+fixture.sourceId,JSON.stringify({text:'Local visual fixture only; no provider/model execution.'}),fixture.issueId])
 await tx.query('INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,stage,status,revision,"attemptId",reason) VALUES($1,$2,$3,$4,$5,\'review\',\'failed\',24,$6,$7)',[fixture.taskId,scope.owner.userId,fixture.issueId,fixture.sourceId,JSON.stringify({kind:'factory',needsSpec:false,missingInformation:[],missingPermissions:[],rationale:'Isolated visual fixture'}),fixture.attemptId,'Independent review failed · 独立审查失败'])
 await tx.query('INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId","machineName") VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[fixture.candidateId,fixture.taskId,'8f418086fff9bcd42d17e32de7b7f4a968fdfc0a','alexj11324/Mikka','local-visual-fixture','Visual review only',fixture.producerId,'Vercel visual fixture'])
 await tx.query('INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"candidateId",reason,output) VALUES($1,$2,\'review\',1,1,\'failed\',$3,$4,$5)',[fixture.attemptId,fixture.taskId,fixture.candidateId,'Independent review failed · 独立审查失败',JSON.stringify({requestEpoch:fixture.sourceId})])
 await tx.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1',[fixture.taskId,fixture.candidateId])
 await tx.query('COMMIT')
}catch(e){await tx.query('ROLLBACK');throw e}finally{tx.release()}
const api = await scope.owner.request('/api/factory/tasks/'+fixture.taskId)
const data=await api.json()
if(api.status!==200 || !data.liveWorkspaceId) throw new Error('FACTORY_AUTHORIZED_SCOPE_MISSING');
console.log(JSON.stringify({ready:'fixtures',liveWorkspaceId:data.liveWorkspaceId,apiStatus:api.status,task:data.task?{id:data.task.id,stage:data.task.stage,status:data.task.status,revision:data.task.revision}:data,checks:data.checks?.length}))
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']})
const context=await browser.newContext({storageState:scope.owner.storageStatePath,viewport:{width:1440,height:960},colorScheme:'light',locale:'zh-CN'})
const page=await context.newPage()
const shots='/tmp/mikka-1220-screenshots'
await mkdir(shots,{recursive:true})
let locale='zh-CN'
await page.goto(environment.origin+environment.basePath+'/'+locale+'?issue='+fixture.issueId,{waitUntil:'networkidle'})
console.log(JSON.stringify({ready:'browser',url:page.url(),text:(await page.locator('body').innerText()).slice(0,15000),fixture}))

const manifest={commit:process.env.MIKKA_TEST_DEPLOYMENT_SHA,environmentId:environment.id,origin:environment.origin,fixture,liveWorkspaceId:data.liveWorkspaceId,startedAt:new Date().toISOString(),purpose:'Screenshot-only UI inspection; no browser test suite or model execution',captures:[]}
try {
 for(const currentLocale of ['zh-CN','en']) {
  locale=currentLocale
  await scope.assertActive()
  await page.setViewportSize({width:1440,height:960})
  await page.goto(environment.origin+environment.basePath+'/'+locale+'?issue='+fixture.issueId,{waitUntil:'networkidle'})
  await page.getByRole('button',{name:locale==='en'?'Factory acceptance':'Factory 验收',exact:true}).click()
  await page.evaluate(()=>document.fonts.ready)
  for(const width of [1440,390]) for(const scheme of ['light','dark']) {
   await page.setViewportSize({width,height:width===390?844:960})
   await page.emulateMedia({colorScheme:scheme})
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
   const name=(locale==='en'?'en':'zh')+'-factory-live-'+width+'-'+scheme+'.png'
   const path=shots+'/'+name
   await page.screenshot({path})
   manifest.captures.push({name,locale,width,height:width===390?844:960,scheme,sha256:createHash('sha256').update(await readFile(path)).digest('hex'),visibleText:(await page.locator('body').innerText()).slice(-12000)})
   await writeFile(shots+'/manifest.json',JSON.stringify(manifest,null,2))
   originalLog(JSON.stringify({progress:manifest.captures.length,name}))
  }
 }
 manifest.finishedAt=new Date().toISOString()
 await writeFile(shots+'/manifest.json',JSON.stringify(manifest,null,2))
 const audited=await auditEvidence([shots],{environment})
 console.log(JSON.stringify({finished:true,captures:manifest.captures.length,audit:audited,manifest:shots+'/manifest.json'}))
} finally {
 await browser.close()
 await scope.release({outcome:'dirty'})
 await db.end()
}
