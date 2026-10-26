import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rename,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createNativeRegistry} from './native-resource-registry.ts'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import type {Pool} from 'pg'
import {Daemon} from '../src/main'
import {HttpServerLink} from '../src/server-link-http'
import {createNativeGroupProcessor} from '../src/adapters/group-review'
interface Fixtures {pool:Pool;command:(id:string,user:string,input:unknown)=>Promise<unknown>;port:number;agentId:string;ccAgentId:string;newRequest:(target?:string,comment?:string)=>Promise<{path:string;group:{id:string};base:{artifactId:string;baseVersionId:string;baseHash:string};work:{workId:string}}>;post:(path:string,input:unknown,user?:string)=>Promise<any>;worker:(input:unknown,user?:string)=>Promise<any>}
export async function nativeGroupAcceptance({pool,command,port,agentId,ccAgentId,newRequest,post,worker}:Fixtures){
   assert.equal(process.env.MIKKA_NATIVE_DISPOSAL_AUTHORIZED,'1','Native acceptance requires explicit authorization for task-owned container and runtime-directory deletion (ordinary test-process stop is not blocked)')

   const exec=promisify(execFile),build=await mkdtemp(join(tmpdir(),'mgn-img-'))
   let image='',badImage='',badCapImage='',missingCapImage='',dataDir=''
   const dockerKeys=['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG'] as const
   const oldDocker=Object.fromEntries(dockerKeys.map(key=>[key,process.env[key]]))
   const originalPath=process.env.PATH,realDockerPath=(await exec('which',['docker'])).stdout.trim()
   const registry=join(build,'resource-receipts'),auditBin=join(build,'audit-bin')
   const resources=createNativeRegistry(registry,join(build,'docker-config'),{requests:30,configs:9})
   const configLifecycle=resources.retainedConfigLifecycle()
   const newNativeProcessor=(value:unknown)=>createNativeGroupProcessor(value,configLifecycle)
   const registryHelper=fileURLToPath(new URL('./native-resource-registry.ts',import.meta.url))
   await mkdir(auditBin)
   await writeFile(join(auditBin,'docker'),`#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const result=spawnSync(process.execPath,[${JSON.stringify(registryHelper)},${JSON.stringify(registry)},${JSON.stringify(realDockerPath)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(result.status??1)\n`,{mode:0o700})
   process.env.PATH=auditBin+':'+originalPath
   const previous=process.env.PRIVATE_HOST_SENTINEL
   process.env.PRIVATE_HOST_SENTINEL='PRIVATE_HOST_SENTINEL'
   try{
    await copyFile(new URL('./fakes/group-review-native.mjs',import.meta.url),join(build,'fake.mjs'))
    await writeFile(join(build,'Dockerfile'),'FROM node:24-bookworm-slim\nCOPY fake.mjs /usr/local/bin/claude\nCOPY fake.mjs /usr/local/bin/codex\nRUN chmod 755 /usr/local/bin/claude /usr/local/bin/codex\n')
    await mkdir(join(build,'docker-config'),{mode:0o700})
    image=(await exec('docker',['build','--rm=false','--force-rm=false','--network=none','--quiet',build],{timeout:60000,env:{PATH:process.env.PATH,NODE_ENV:'test',DOCKER_CONFIG:join(build,'docker-config'),DOCKER_BUILDKIT:'0'}})).stdout.trim()
    assert.match(image,/^sha256:[a-f0-9]{64}$/)
    process.env.DOCKER_HOST='tcp://127.0.0.1:1'
    process.env.DOCKER_CONTEXT='must-not-be-inherited'
    process.env.DOCKER_CONFIG=join(build,'poisoned-docker-config')
    dataDir=await mkdtemp(join(tmpdir(),'mgn-'));const link=new HttpServerLink(`http://127.0.0.1:${port}`)
    const daemon=await new Daemon({dataDir,flavor:'dev',link,credential:'controlled-device-fixture',harnesses:[],quotaSource:null,agentSandbox:null,heartbeatMs:100,groupReviewImages:{claude_code:image,codex:image},groupReviewConfigLifecycle:configLifecycle}).start()
    const awaitWork=async(id:string,predicate:(w:Record<string,unknown>)=>boolean)=>{for(let i=0;i<200;i++){const w=(await pool.query('SELECT * FROM conversation_work WHERE id=$1',[id])).rows[0];if(predicate(w))return w;await new Promise(r=>setTimeout(r,50))}throw Error('Native daemon fixture timed out')}
    try{
     for(const target of [ccAgentId,agentId]){
      const r=await newRequest(target,'fixture:unicode '+'中文🌍'.repeat(4000))
      await awaitWork(r.work.workId,w=>w.status==='completed')
      const detail=await post(r.path,{action:'read',artifactId:r.base.artifactId})
      assert.equal(detail.versions.length,2);assert.equal(detail.artifact.acceptedVersionId,null)
      assert.match(detail.threads[0].comments.at(-1).body,target===ccAgentId?/CC controlled/:/Codex controlled/)
      assert.equal(detail.versions[1].content,'# Controlled revision 中文 🌍')
      const work=(await pool.query('SELECT * FROM conversation_work WHERE id=$1',[r.work.workId])).rows[0]
      await assert.rejects(worker({action:'complete',runId:work.runId,reply:{workId:work.id,triggerMessageId:work.triggerMessageId,claimEpoch:work.claimEpoch,body:'duplicate native completion'}}),/result_mismatch/)
      assert.equal((await post(r.path,{action:'read',artifactId:r.base.artifactId})).versions.length,2)
      await worker({action:'fail',runId:work.runId,claimEpoch:work.claimEpoch,code:'processor_failed'})
      assert.equal((await pool.query('SELECT error FROM agent_runs WHERE id=$1',[work.runId])).rows[0].error,null)
     }
     for(const target of [ccAgentId,agentId]){
      const r=await newRequest(target,'fixture:drain')
      await awaitWork(r.work.workId,w=>w.status==='completed')
      const detail=await post(r.path,{action:'read',artifactId:r.base.artifactId})
      assert.equal(detail.versions[1].content,'中文🌍'+'x'.repeat(900000))
     }
     const lateTool=await newRequest(agentId,'fixture:drain-tool')
     await awaitWork(lateTool.work.workId,w=>w.status==='cancelled')
     assert.equal((await post(lateTool.path,{action:'read',artifactId:lateTool.base.artifactId})).versions.length,1)
     for(const target of [ccAgentId,agentId])for(const mode of ['malformed','oversized','shape','content-limit']){
      const r=await newRequest(target,'fixture:'+mode)
      await awaitWork(r.work.workId,w=>w.claimEpoch===1)
      // Failed/invalid CLI output must never become an Agent reply or revision.
      const failed=await awaitWork(r.work.workId,w=>w.status==='cancelled')
      assert.equal(failed.status,'cancelled')
      assert.equal((await pool.query('SELECT error FROM agent_runs WHERE id=$1',[r.work.workId])).rows[0].error,'group_processor_failed')
      assert.equal((await post(r.path,{action:'read',artifactId:r.base.artifactId})).versions.length,1)
      assert.equal((await pool.query('SELECT count(*) FROM conversation_messages WHERE "conversationId"=$1 AND "authorType"=\'agent\'',[r.group.id])).rows[0].count,'0')
      await command(r.group.id,'member',{action:'cancel',workId:r.work.workId})
     }
     for(const target of [ccAgentId,agentId]){
      const r=await newRequest(target,'fixture:delay')
      await awaitWork(r.work.workId,w=>w.claimEpoch===1)
      const human=await post(r.path,{action:'revise',...r.base,content:'# Concurrent human winner'})
      await awaitWork(r.work.workId,w=>w.status==='conflict')
      const detail=await post(r.path,{action:'read',artifactId:r.base.artifactId})
      assert.equal(detail.artifact.headVersionId,human.version.id);assert.equal(detail.versions.length,3);assert.equal(detail.artifact.acceptedVersionId,null)
     }
     const stale=await newRequest(agentId,'fixture:delay')
     const first=await awaitWork(stale.work.workId,w=>w.claimEpoch===1)
     await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\' WHERE id=$1',[stale.work.workId])
     await command(stale.group.id,'owner',{action:'work',workId:stale.work.workId})
     await awaitWork(stale.work.workId,w=>Boolean(w.uncertainAt))
     await assert.rejects(worker({action:'complete',runId:stale.work.workId,reply:{workId:stale.work.workId,triggerMessageId:first.triggerMessageId,claimEpoch:1,body:'old native output'}}),/execution_uncertain/)
     assert.equal((await pool.query('SELECT "claimEpoch" FROM conversation_work WHERE id=$1',[stale.work.workId])).rows[0].claimEpoch,1)
     await command(stale.group.id,'owner',{action:'reconcile',workId:stale.work.workId,decision:'abandon'})
     const tool=await newRequest(agentId,'fixture:tool');await awaitWork(tool.work.workId,w=>w.status==='cancelled')
     assert.equal((await post(tool.path,{action:'read',artifactId:tool.base.artifactId})).versions.length,1)
     const r=await newRequest(agentId,'fixture:wait')
     await awaitWork(r.work.workId,w=>w.claimEpoch===1)
     await command(r.group.id,'owner',{action:'revoke',agentId})
     await awaitWork(r.work.workId,w=>w.status==='cancelled')
     await new Promise(r=>setTimeout(r,1200))
     assert.equal((await post(r.path,{action:'read',artifactId:r.base.artifactId})).versions.length,1)
     await daemon.stop()
     const limit=await newRequest();await worker({action:'poll'})
     await pool.query('UPDATE conversation_work SET "claimEpoch"=3 WHERE id=$1',[limit.work.workId])
     assert.equal((await worker({action:'claim',runId:limit.work.workId})).status,'uncertain')
    }finally{await daemon.stop()} // Always retain the uniquely created task directory.
    // Missing compatibility/isolation capability fails closed before execution.
    await assert.rejects(createNativeGroupProcessor({codex:'latest'}))
    await assert.rejects(newNativeProcessor({codex:'sha256:'+'0'.repeat(64)}))
    const fake=await readFile(join(build,'fake.mjs'),'utf8')
    await writeFile(join(build,'fake.mjs'),fake.replace('codex-cli 0.162.1','codex-cli 0.1.0'))
    badImage=(await exec('docker',['build','--rm=false','--force-rm=false','--network=none','--quiet',build],{timeout:60000,env:{PATH:process.env.PATH,NODE_ENV:'test',DOCKER_CONFIG:join(build,'docker-config'),DOCKER_BUILDKIT:'0'}})).stdout.trim()
    await assert.rejects(newNativeProcessor({codex:badImage}),/Unsupported Codex/)
    await writeFile(join(build,'fake.mjs'),fake.replace('multi_agent_v2 stable false','multi_agent_v2 stable true').replace('--bare --restricted --tools','--bare --tools'))
    badCapImage=(await exec('docker',['build','--rm=false','--force-rm=false','--network=none','--quiet',build],{timeout:60000,env:{PATH:process.env.PATH,NODE_ENV:'test',DOCKER_CONFIG:join(build,'docker-config'),DOCKER_BUILDKIT:'0'}})).stdout.trim()
    await assert.rejects(newNativeProcessor({codex:badCapImage}),/tool-disable capability/)
    await assert.rejects(newNativeProcessor({claude_code:badCapImage}),/Required Claude/)
    await writeFile(join(build,'fake.mjs'),fake.replace('multi_agent_v2 stable false','unavailable_feature stable false'))
    missingCapImage=(await exec('docker',['build','--rm=false','--force-rm=false','--network=none','--quiet',build],{timeout:60000,env:{PATH:process.env.PATH,NODE_ENV:'test',DOCKER_CONFIG:join(build,'docker-config'),DOCKER_BUILDKIT:'0'}})).stdout.trim()
    await assert.rejects(newNativeProcessor({codex:missingCapImage}),/tool-disable capability/)
    const processor=await newNativeProcessor({claude_code:image})
    try{
     const r=await newRequest(ccAgentId);await worker({action:'poll'})
     const assignment=await worker({action:'claim',runId:r.work.workId})
     const controller=new AbortController(),pending=processor(assignment,controller.signal)
     // Cancel while create is in flight, before start/attach can run.
     controller.abort()
     await assert.rejects(pending,/stopped before start/)
     assert.equal((await post(r.path,{action:'read',artifactId:r.base.artifactId})).versions.length,1)
     await command(r.group.id,'member',{action:'cancel',workId:r.work.workId})
    }finally{await processor.dispose()}
    // A daemon can finish creation after its client timed out. A detached
    // controlled shim reproduces that edge with a real, unstarted container.
    const realDocker=(await exec('which',['docker'])).stdout.trim(),pathBefore=process.env.PATH
    const shim=join(build,'shim'),marker=join(build,'late-create-confirmed')
    await mkdir(shim)
    const delayed=`const {spawnSync}=require('node:child_process');const {writeFileSync}=require('node:fs');setTimeout(()=>{const p=spawnSync(${JSON.stringify(realDocker)},JSON.parse(process.argv[1]),{stdio:'ignore'});writeFileSync(${JSON.stringify(marker)},String(p.status))},5200)`
    const shimLog=join(build,'delayed-create.log')
    await writeFile(join(shim,'docker'),`#!/usr/bin/env node\nconst {spawn,spawnSync}=require('node:child_process');const {openSync}=require('node:fs');const args=process.argv.slice(2);if(args.includes('create')){const p=spawn(process.execPath,['-e',${JSON.stringify(delayed)},JSON.stringify(args)],{detached:true,stdio:['ignore',openSync(${JSON.stringify(shimLog)},'a'),openSync(${JSON.stringify(shimLog)},'a')]});p.unref();setTimeout(()=>{},20000)}else{process.exit(spawnSync(${JSON.stringify(realDocker)},args,{stdio:'inherit'}).status??1)}\n`,{mode:0o700})
    try{process.env.PATH=shim+':'+pathBefore;await assert.rejects(newNativeProcessor({codex:image}),error=>{assert.match(String(error),/Command failed:.* create /s);return true})}
    finally{if(pathBefore===undefined)delete process.env.PATH;else process.env.PATH=pathBefore}
    let lateCreate=''
    for(let i=0;i<40;i++){try{lateCreate=await readFile(marker,'utf8');break}catch{await new Promise(resolve=>setTimeout(resolve,25))}}
    assert.equal(lateCreate,'0','timeout regression must actually create its delayed disposable container: '+await readFile(shimLog,'utf8'))
    const blockRm=join(build,'block-rm'),ownedNames=join(build,'cleanup-owned-names')
    await writeFile(join(shim,'docker'),`#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const {existsSync,appendFileSync}=require('node:fs');const args=process.argv.slice(2);if(args.includes('create')&&args.includes('--name'))appendFileSync(${JSON.stringify(ownedNames)},args[args.indexOf('--name')+1]+'\\n');if(args.includes('rm')&&existsSync(${JSON.stringify(blockRm)})){process.stderr.write('controlled cleanup unavailable');process.exit(1)}process.exit(spawnSync(${JSON.stringify(realDocker)},args,{stdio:'inherit'}).status??1)\n`,{mode:0o700})
    const localDocker=(args:string[])=>exec(realDocker,['--host','unix:///var/run/docker.sock','--config',join(build,'docker-config'),...args],{env:{PATH:pathBefore,NODE_ENV:'test'},timeout:5000})
    try{
     process.env.PATH=shim+':'+pathBefore
     const failingCleanup=await newNativeProcessor({claude_code:image})
     const r=await newRequest(ccAgentId,'fixture:wait');await worker({action:'poll'})
     const assignment=await worker({action:'claim',runId:r.work.workId}),controller=new AbortController()
     const pending=failingCleanup(assignment,controller.signal)
     const rejected=assert.rejects(pending,/cleanup unconfirmed/)
     try{
      let running=''
      for(let i=0;i<80;i++){
       const owned=new Set((await readFile(ownedNames,'utf8')).trim().split('\n').filter(Boolean))
       for(const entry of resources.created().filter(entry=>owned.has(entry.name))){
        try{if((await localDocker(['inspect','--type','container','--format','{{.State.Running}}',entry.id])).stdout.trim()==='true'){running=entry.id;break}}catch(error){if(!/No such (?:container|object)/.test(String((error as {stderr?:string}).stderr)))throw error}
       }
       if(running)break;await new Promise(resolve=>setTimeout(resolve,25))
      }
      assert.ok(running,'cleanup failure regression must start its isolated fixture')
      await writeFile(blockRm,'1')
      // Simulate the worker's abort race settling before native cleanup does.
      const abortRace=Promise.race([pending,new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('fixture aborted')),{once:true}))])
      controller.abort();await assert.rejects(abortRace,/fixture aborted/)
      await assert.rejects(failingCleanup.dispose(),/cleanup unconfirmed/)
      await rejected
      await assert.rejects(failingCleanup(assignment,new AbortController().signal),/disposed/)
     }finally{
      controller.abort();await rename(blockRm,blockRm+'.retained').catch(error=>{if(error.code!=='ENOENT')throw error})
      const owned=new Set((await readFile(ownedNames,'utf8')).trim().split('\n').filter(Boolean))
      for(const entry of resources.created().filter(entry=>owned.has(entry.name)))await localDocker(['rm','--force',entry.id])
      await failingCleanup.dispose().catch(()=>{})
      await command(r.group.id,'member',{action:'cancel',workId:r.work.workId})
     }
    }finally{if(pathBefore===undefined)delete process.env.PATH;else process.env.PATH=pathBefore}
    for(const config of resources.configs()){resources.verifyConfig(config.path);await readdir(config.path)}
    for(const entry of resources.created())await assert.rejects(localDocker(['inspect','--type','container','--format','{{.Id}}',entry.id]),(error:unknown)=>/No such (?:container|object)/.test(String((error as {stderr?:string}).stderr)),'owned full-ID container must not remain')
   }finally{
    if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath
    if(previous===undefined)delete process.env.PRIVATE_HOST_SENTINEL;else process.env.PRIVATE_HOST_SENTINEL=previous
    for(const key of dockerKeys){if(oldDocker[key]===undefined)delete process.env[key];else process.env[key]=oldDocker[key]}
    // All directories/receipts and images survive. Container deletion remains gated.
    const receipt={build,dataDir,registry,runId:resources.owner.runId,images:[image,badImage,badCapImage,missingCapImage].filter(Boolean),retained:true,runtimeConfigsRetained:true,runtimeContainerDeletionStillRequired:true};await writeFile(join(build,'retained-resources.json'),JSON.stringify(receipt,null,2));console.log('Native retained resources: '+JSON.stringify(receipt))
   }

}
