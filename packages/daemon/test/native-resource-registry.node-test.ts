import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readdirSync,renameSync,symlinkSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createNativeRegistry,NativeRegistry,auditedNativeDocker} from './native-resource-registry.ts'
import type {DockerResult} from './native-resource-registry.ts'
import {createNativeConfigDirectory,disposeNativeConfigDirectory} from '../src/adapters/group-review.ts'

const exec=promisify(execFile),image='sha256:'+'1'.repeat(64),id='2'.repeat(64)
function fixture(limits={requests:30,configs:9}){
 const root=mkdtempSync(join(tmpdir(),'native-registry-pure-')),config=join(root,'docker-config')
 mkdirSync(config,{mode:0o700})
 const registry=createNativeRegistry(join(root,'receipts'),config,limits)
 const prefix=['--host','unix:///var/run/docker.sock','--config',config]
 const calls:string[][]=[],containers=new Map<string,any>()
 const execute=(args:string[],_capture:boolean):DockerResult=>{
  calls.push(args)
  if(args[4]==='create'){
   const name=args[args.indexOf('--name')+1],labels:Record<string,string>={}
   for(let i=0;i<args.length;i++)if(args[i]==='--label'){const [key,...value]=args[i+1].split('=');labels[key]=value.join('=')}
   containers.set(id,{Id:id,Name:'/'+name,Image:image,Config:{Labels:labels}})
   return {status:0,stdout:id+'\n'}
  }
  if(args[4]==='inspect'){
   const target=args.at(-1),info=[...containers.values()].find(x=>x.Id===target||x.Name==='/'+target)
   return info?{status:0,stdout:JSON.stringify(info)}:{status:1,stderr:'No such container'}
  }
  if(args[4]==='rm'){
   assert.match(args.at(-1)!,/^[a-f0-9]{64}$/)
   containers.delete(args.at(-1)!) // In-memory mock only; no Docker or filesystem removal.
   return {status:0,stdout:id}
  }
  return {status:0}
 }
 return {root,config,registry,prefix,calls,containers,execute}
}
const createArgs=(prefix:string[],name:string)=>[...prefix,'create','--rm','--name',name,'--pull=never',image]

test('creates have private receipts, labels and full IDs; rm inspects and uses only full ID',()=>{
 const f=fixture(),name='mikka-group-cli-'+randomUUID()
 auditedNativeDocker(f.registry,createArgs(f.prefix,name),f.execute)
 assert.equal(f.registry.created().length,1);assert.equal(f.registry.created()[0].id,id)
 const inspected={...f.containers.get(id),State:{Running:false,Pid:0},HostConfig:{AutoRemove:false}}
 const snapshot=f.registry.setupSnapshot(target=>{assert.equal(target,id);return inspected})
 assert.equal(snapshot.containerCount,1);assert.equal(snapshot.approvalEligible,false);assert.equal(snapshot.executedDeletion,false)
 assert.throws(()=>f.registry.setupSnapshot(()=>({...inspected,HostConfig:{AutoRemove:true}})),/implicit disposal/)
 assert.throws(()=>f.registry.setupSnapshot(()=>({...inspected,State:{Running:true,Pid:123}})),/stopped/)

 assert.ok(f.calls[0].includes('--rm'),'original adapter auto-removal semantics must be preserved')
 auditedNativeDocker(f.registry,[...f.prefix,'rm','--force',name],f.execute)
 const removal=f.calls.findIndex(args=>args[4]==='rm')
 assert.deepEqual(f.calls[removal].slice(4),['rm','--force',id])
 assert.equal(f.calls[removal-1][4],'inspect');assert.equal(f.calls[removal-1].at(-1),id)
 assert.ok(readdirSync(join(f.registry.directory,'events')).length>0)
})

test('foreign identity, short IDs, unknown names, multi-target and broad removal fail closed',()=>{
 const f=fixture(),name='mikka-group-cli-'+randomUUID()
 auditedNativeDocker(f.registry,createArgs(f.prefix,name),f.execute)
 for(const target of [id.slice(0,12),'mikka-group-cli-unknown','all'])assert.throws(()=>auditedNativeDocker(f.registry,[...f.prefix,'rm','--force',target],f.execute))
 assert.throws(()=>auditedNativeDocker(f.registry,[...f.prefix,'rm','--force',id,id],f.execute))
 assert.throws(()=>auditedNativeDocker(f.registry,[...f.prefix,'container','prune'],f.execute))
 const info=f.containers.get(id),original={...info.Config.Labels}
 for(const label of ['mikka.test.native.owner','mikka.test.native.receipt']){
  info.Config.Labels={...original,[label]:'foreign'}
  assert.throws(()=>auditedNativeDocker(f.registry,[...f.prefix,'rm','--force',id],f.execute))
 }
 info.Config.Labels=original;info.Image='sha256:'+'9'.repeat(64)
 assert.throws(()=>auditedNativeDocker(f.registry,[...f.prefix,'rm','--force',id],f.execute))
 assert.ok(!f.calls.some(args=>args[4]==='rm'))
})

test('unconfirmed late create is recovered by exact receipt identity before full-ID cleanup',()=>{
 const f=fixture(),name='mikka-group-cli-'+randomUUID(),request=f.registry.reserveCreate(name,image)
 const missing=auditedNativeDocker(f.registry,[...f.prefix,'rm','--force',name],f.execute)
 assert.equal(missing.status,1);assert.equal(f.registry.created().length,0)
 f.containers.set(id,{Id:id,Name:'/'+name,Image:image,Config:{Labels:{'mikka.test.native.owner':request.owner,'mikka.test.native.receipt':request.receipt}}})
 auditedNativeDocker(f.registry,[...f.prefix,'rm','--force',name],f.execute)
 assert.equal(f.registry.created()[0].id,id)
 // Known absence is recorded, never passed to Docker rm as a name or prefix.
 const removals=f.calls.filter(args=>args[4]==='rm').length
 assert.equal(auditedNativeDocker(f.registry,[...f.prefix,'rm','--force',id],f.execute).status,0)
 assert.equal(f.calls.filter(args=>args[4]==='rm').length,removals)
})

test('failed removal remains recoverable without allocating another create request',()=>{
 const f=fixture(),name='mikka-group-cli-'+randomUUID()
 auditedNativeDocker(f.registry,createArgs(f.prefix,name),f.execute)
 const fail=(args:string[],capture:boolean)=>args[4]==='rm'?{status:1,stderr:'controlled failure'}:f.execute(args,capture)
 assert.equal(auditedNativeDocker(f.registry,[...f.prefix,'rm','--force',id],fail).status,1)
 assert.equal(auditedNativeDocker(new NativeRegistry(f.registry.directory),[...f.prefix,'rm','--force',id],f.execute).status,0)
 assert.equal(readdirSync(join(f.registry.directory,'requests')).length,1)
})

test('36 concurrent processes cannot reserve more than 30 create requests',async()=>{
 const f=fixture(),module=new URL('./native-resource-registry.ts',import.meta.url).href
 const source=`import {NativeRegistry} from ${JSON.stringify(module)};import {randomUUID} from 'node:crypto';try{new NativeRegistry(process.argv[1]).reserveCreate('mikka-group-cli-'+randomUUID(),${JSON.stringify(image)});process.stdout.write('reserved')}catch{process.stdout.write('refused')}`
 const results=await Promise.all(Array.from({length:36},()=>exec(process.execPath,['--input-type=module','-e',source,f.registry.directory])))
 assert.equal(results.filter(r=>r.stdout==='reserved').length,30)
 assert.equal(results.filter(r=>r.stdout==='refused').length,6)
 assert.equal(readdirSync(join(f.registry.directory,'requests')).length,30)
})

test('concurrent config registration deduplicates one directory and refuses the tenth',async()=>{
 const f=fixture();f.registry.reserveConfigCreation()
 const config=mkdtempSync(join(tmpdir(),'mikka-group-docker-pure-'))
 const module=new URL('./native-resource-registry.ts',import.meta.url).href
 const source=`import {NativeRegistry} from ${JSON.stringify(module)};new NativeRegistry(process.argv[1]).registerConfig(process.argv[2])`
 await Promise.all(Array.from({length:8},()=>exec(process.execPath,['--input-type=module','-e',source,f.registry.directory,config])))
 assert.equal(f.registry.configs().length,1)
 for(let n=1;n<9;n++){f.registry.reserveConfigCreation();f.registry.registerConfig(mkdtempSync(join(tmpdir(),'mikka-group-docker-pure-')))}
 assert.throws(()=>f.registry.reserveConfigCreation(),/budget/)
 assert.equal(f.registry.configs().length,9)
 // Every synthetic directory and receipt is deliberately retained.
})

test('config registration without an earlier reservation is refused; exhausted reservation never invokes creator',()=>{
 const f=fixture({requests:1,configs:1})
 assert.throws(()=>f.registry.registerConfig(mkdtempSync(join(tmpdir(),'mikka-group-docker-pure-'))),/prior creation reservation/)
 let invoked=0
 const create=()=>{f.registry.reserveConfigCreation();invoked++}
 create();assert.throws(create,/budget/);assert.equal(invoked,1)
})

test('budget exhaustion happens before create and invalid limits are refused',()=>{
 const f=fixture({requests:1,configs:1})
 f.registry.reserveCreate('mikka-group-cli-'+randomUUID(),image)
 assert.throws(()=>auditedNativeDocker(f.registry,createArgs(f.prefix,'mikka-group-cli-'+randomUUID()),f.execute),/budget/)
 assert.equal(f.calls.length,0)
 assert.throws(()=>createNativeRegistry(join(f.root,'bad'),f.config,{requests:31,configs:9}))
 assert.throws(()=>createNativeRegistry(join(f.root,'bad-config'),f.config,{requests:30,configs:10}))
})

test('successful create output is retained if inspect is unavailable; ownership still required for recovery',()=>{
 const f=fixture(),name='mikka-group-cli-'+randomUUID()
 const unavailable=(args:string[],capture:boolean)=>args[4]==='inspect'?{status:1,stderr:'controlled unavailable'}:f.execute(args,capture)
 assert.throws(()=>auditedNativeDocker(f.registry,createArgs(f.prefix,name),unavailable),/identity unavailable/)
 assert.equal(f.registry.created().length,0)
 assert.equal(readdirSync(join(f.registry.directory,'events')).length,1)
 assert.equal(auditedNativeDocker(f.registry,[...f.prefix,'rm','--force',name],f.execute).status,0)
 assert.equal(f.registry.created()[0].id,id)
})

test('a registered name cannot be rebound to another full ID',()=>{
 const f=fixture(),name='mikka-group-cli-'+randomUUID()
 auditedNativeDocker(f.registry,createArgs(f.prefix,name),f.execute)
 const info={...f.containers.get(id),Id:'3'.repeat(64)}
 assert.throws(()=>f.registry.recordCreated(f.registry.request(name),info),/rebound/)
 assert.equal(f.registry.created().length,1)
})

test('start requires a completed receipt and matching identity, then uses full ID with original auto-removal',()=>{
 const f=fixture(),name='mikka-group-cli-'+randomUUID()
 const start=(target:string,execute=f.execute)=>auditedNativeDocker(f.registry,[...f.prefix,'start','--attach','--interactive',target],execute)
 assert.throws(()=>start(name));assert.equal(f.calls.length,0)
 const pending='mikka-group-cli-'+randomUUID();f.registry.reserveCreate(pending,image)
 assert.throws(()=>start(pending),/completed full-ID/);assert.equal(f.calls.length,0)
 auditedNativeDocker(f.registry,createArgs(f.prefix,name),f.execute)
 const info=f.containers.get(id),labels=info.Config.Labels
 info.Config.Labels={...labels,'mikka.test.native.owner':'foreign'}
 assert.throws(()=>start(name));assert.ok(!f.calls.some(args=>args[4]==='start'))
 info.Config.Labels=labels
 const autoRemove=(args:string[],capture:boolean)=>{
  if(args[4]==='start'){
   assert.equal(args.at(-1),id);f.calls.push(args);f.containers.delete(id)
   return {status:0}
  }
  return f.execute(args,capture)
 }
 assert.equal(start(name,autoRemove).status,0)
 assert.equal(auditedNativeDocker(f.registry,[...f.prefix,'rm','--force',name],f.execute).status,0)
 assert.ok(!f.calls.some(args=>args[4]==='rm'),'auto-removed full ID is recorded absent without another deletion')
})

test('actual runtime directory lifecycle reserves before creation and retention never calls disposal',async()=>{
 const f=fixture({requests:1,configs:1}),lifecycle=f.registry.retainedConfigLifecycle()
 const path=await createNativeConfigDirectory(lifecycle)
 assert.equal(f.registry.configs().length,1);f.registry.verifyConfig(path)
 let removed=0
 await disposeNativeConfigDirectory(path,lifecycle,async()=>{removed++})
 await disposeNativeConfigDirectory(path,lifecycle,async()=>{removed++})
 assert.equal(removed,0);assert.ok(readdirSync(path).includes('.mikka-native-fixture-owner'))
 let registered=0
 await assert.rejects(createNativeConfigDirectory({...lifecycle,created:()=>{registered++}}),/budget/)
 assert.equal(registered,0);assert.equal(f.registry.configs().length,1)
})

test('runtime disposal refuses directory replacement and symlink redirection without calling remover',async()=>{
 for(const symlink of [false,true]){
  const f=fixture(),lifecycle=f.registry.retainedConfigLifecycle(),path=await createNativeConfigDirectory(lifecycle)
  renameSync(path,path+'.retained')
  if(symlink)symlinkSync(path+'.retained',path)
  else mkdirSync(path,{mode:0o700})
  let removed=0
  await assert.rejects(disposeNativeConfigDirectory(path,lifecycle,async()=>{removed++}),/replaced|redirected/)
  assert.equal(removed,0);assert.ok(readdirSync(path+'.retained').includes('.mikka-native-fixture-owner'))
 }
})

test('runtime disposal refuses changed profile marker or registry owner',async()=>{
 for(const marker of [true,false]){
  const f=fixture(),lifecycle=f.registry.retainedConfigLifecycle(),path=await createNativeConfigDirectory(lifecycle)
  const target=marker?join(path,'.mikka-native-fixture-owner'):join(f.registry.directory,'owner.json')
  const original=readFileSync(target,'utf8')
  writeFileSync(target+'.retained',original,{flag:'wx',mode:0o600})
  writeFileSync(target,JSON.stringify({...JSON.parse(original),owner:'f'.repeat(64)}))
  let removed=0
  await assert.rejects(disposeNativeConfigDirectory(path,lifecycle,async()=>{removed++}),/owner changed/)
  assert.equal(removed,0)
 }
})

test('registration failure retains newly created runtime directory and never invokes disposal',async()=>{
 let created=''
 await assert.rejects(createNativeConfigDirectory({beforeCreate(){},created(path){created=path;throw Error('fixture registration failed')},beforeDispose(){throw Error('must not dispose')}}),/registration failed/)
 assert.ok(created);assert.deepEqual(readdirSync(created),[])
})

test('default product disposal still invokes its remover and invalid lifecycle decisions fail closed',async()=>{
 // Fake callback only: no filesystem or container deletion.
 let removed=0
 await disposeNativeConfigDirectory('/unused-fake-path',undefined,async path=>{assert.equal(path,'/unused-fake-path');removed++})
 assert.equal(removed,1)
 await assert.rejects(disposeNativeConfigDirectory('/unused-fake-path',{beforeCreate(){},created(){},beforeDispose(){return undefined as never}},async()=>{removed++}),/Unknown/)
 assert.equal(removed,1)
})
