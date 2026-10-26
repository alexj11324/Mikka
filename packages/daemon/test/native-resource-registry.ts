import assert from 'node:assert/strict'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {mkdirSync,openSync,writeFileSync,closeSync,fsyncSync,readFileSync,lstatSync,readdirSync,linkSync} from 'node:fs'
import {join,resolve,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const fullId=/^[a-f0-9]{64}$/
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const ownerLabel='mikka.test.native.owner',receiptLabel='mikka.test.native.receipt'
interface Owner {runId:string;owner:string;requests:number;configs:number;configRoot:string}
interface Request {name:string;image:string;receipt:string;runId:string;owner:string}
interface Created extends Request {id:string}
export interface DockerResult {status:number|null;stdout?:string;stderr?:string}
type Execute=(args:string[],capture:boolean)=>DockerResult
const existsError=(error:unknown)=>(error as NodeJS.ErrnoException).code==='EEXIST'
function exclusive(path:string,value:unknown){
 const fd=openSync(path,'wx',0o600)
 try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd)}finally{closeSync(fd)}
}
function read<T>(path:string):T{
 const stat=lstatSync(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'untrusted registry file')
 assert.equal(stat.uid,process.getuid?.(),'foreign registry file owner')
 return JSON.parse(readFileSync(path,'utf8')) as T
}
export function createNativeRegistry(directory:string,configRoot:string,limits={requests:30,configs:9}){
 assert.ok(Number.isInteger(limits.requests)&&limits.requests>0&&limits.requests<=30)
 assert.ok(Number.isInteger(limits.configs)&&limits.configs>0&&limits.configs<=9)
 mkdirSync(directory,{mode:0o700})
 for(const part of ['requests','names','created','bindings','config-claims','configs','config-bindings','config-records','events'])mkdirSync(join(directory,part),{mode:0o700})
 exclusive(join(directory,'owner.json'),{runId:randomUUID(),owner:randomBytes(32).toString('hex'),...limits,configRoot:resolve(configRoot)})
 return new NativeRegistry(directory)
}
export class NativeRegistry {
 readonly directory:string
 readonly owner:Owner
 constructor(directory:string){
  this.directory=resolve(directory)
  const stat=lstatSync(this.directory);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'untrusted registry directory')
  assert.equal(stat.uid,process.getuid?.(),'foreign registry owner')
  this.owner=read<Owner>(join(this.directory,'owner.json'))
  assert.match(this.owner.owner,fullId)
  assert.ok(Number.isInteger(this.owner.requests)&&this.owner.requests>0&&this.owner.requests<=30)
  assert.ok(Number.isInteger(this.owner.configs)&&this.owner.configs>0&&this.owner.configs<=9)
 }
 private reserve(folder:string,limit:number,value:unknown){
  for(let n=1;n<=limit;n++){
   const path=join(this.directory,folder,`${n}.json`)
   try{exclusive(path,value);return path}catch(error){if(!existsError(error))throw error}
  }
  throw Error(`Native ${folder} creation budget exhausted`)
 }
 reserveConfigCreation(){
  // Harness calls this BEFORE invoking the adapter (and hence before mkdtemp).
  // Failed/unused reservations are never reclaimed or silently reused.
  return this.reserve('configs',this.owner.configs,{owner:this.owner.owner,runId:this.owner.runId,ticket:randomUUID()})
 }
 registerConfig(path:string){
  path=resolve(path)
  assert.ok(basename(path).startsWith('mikka-group-docker-'),'unknown runtime config')
  const stat=lstatSync(path);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'untrusted runtime config')
  assert.equal(stat.uid,process.getuid?.())
  const value={path,dev:stat.dev,ino:stat.ino,owner:this.owner.owner,runId:this.owner.runId}
  const claim=join(this.directory,'config-claims',hash(path)),complete=claim+'.json'
  try{
   exclusive(claim,{owner:this.owner.owner})
   let reserved=false
   for(const file of readdirSync(join(this.directory,'configs')).sort()){
    assert.match(file,/^\d+\.json$/)
    const ticket=read<{owner:string;runId:string}>(join(this.directory,'configs',file))
    assert.equal(ticket.owner,this.owner.owner);assert.equal(ticket.runId,this.owner.runId)
    try{exclusive(join(this.directory,'config-bindings',file),value);reserved=true;break}catch(error){if(!existsError(error))throw error}
   }
   assert.ok(reserved,'runtime config has no prior creation reservation')
   exclusive(join(path,'.mikka-native-fixture-owner'),value)
   const record=join(this.directory,'config-records',hash(path)+'.json')
   exclusive(record,value);linkSync(record,complete)
  }catch(error){
   if(!existsError(error))throw error
   // Another shim may be finishing this same config registration. A crashed
   // claimant leaves an unresolved receipt and fails closed; never steal it.
   let completed=false
   for(let n=0;n<100;n++){
    try{assert.deepEqual(read(complete),value);completed=true;break}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)
   }
   assert.ok(completed,'runtime config registration unresolved')
  }
  assert.deepEqual(read(complete),value)
  assert.deepEqual(read(join(path,'.mikka-native-fixture-owner')),value)
 }
 reserveCreate(name:string,image:string){
  assert.match(name,/^mikka-group-cli-[a-f0-9-]{36}$/)
  assert.match(image,/^sha256:[a-f0-9]{64}$/)
  const request:Request={name,image,receipt:randomUUID(),owner:this.owner.owner,runId:this.owner.runId}
  const slot=this.reserve('requests',this.owner.requests,request)
  // An exact name may never be reused within this run, even after removal.
  linkSync(slot,join(this.directory,'names',hash(name)+'.json'))
  return request
 }
 request(target:string):Request{
  if(fullId.test(target)){
   const created=read<Created>(join(this.directory,'created',target+'.json'))
   assert.equal(created.id,target);return this.request(created.name)
  }
  const request=read<Request>(join(this.directory,'names',hash(target)+'.json'))
  assert.equal(request.name,target);assert.equal(request.owner,this.owner.owner);assert.equal(request.runId,this.owner.runId)
  return request
 }
 verify(request:Request,inspection:unknown):Created{
  const info=inspection as {Id:string;Name:string;Image:string;Config:{Labels:Record<string,string>}}
  assert.equal(request.owner,this.owner.owner);assert.equal(request.runId,this.owner.runId)
  assert.match(info.Id,fullId);assert.equal(info.Name,'/'+request.name);assert.equal(info.Image,request.image)
  assert.equal(info.Config.Labels[ownerLabel],this.owner.owner);assert.equal(info.Config.Labels[receiptLabel],request.receipt)
  return {...request,id:info.Id}
 }
 recordCreated(request:Request,inspection:unknown){
  const created=this.verify(request,inspection),path=join(this.directory,'created',created.id+'.json')
  const binding=join(this.directory,'bindings',hash(request.name)+'.json')
  try{exclusive(binding,{id:created.id,receipt:request.receipt})}catch(error){if(!existsError(error))throw error;assert.deepEqual(read(binding),{id:created.id,receipt:request.receipt},'container name was rebound')}
  try{exclusive(path,created)}catch(error){if(!existsError(error))throw error;assert.deepEqual(read(path),created)}
  return created
 }
 created(){return readdirSync(join(this.directory,'created')).map(file=>{
  assert.match(file,/^[a-f0-9]{64}\.json$/);const entry=read<Created>(join(this.directory,'created',file));assert.equal(entry.id+'.json',file);assert.equal(entry.owner,this.owner.owner);assert.equal(entry.runId,this.owner.runId);return entry
 })}
 configs(){return readdirSync(join(this.directory,'config-records')).map(file=>{
  assert.match(file,/^[a-f0-9]{64}\.json$/)
  const entry=read<{path:string;owner:string;runId:string}>(join(this.directory,'config-records',file))
  assert.equal(entry.owner,this.owner.owner);assert.equal(entry.runId,this.owner.runId)
  return entry
 })}
 event(value:unknown){exclusive(join(this.directory,'events',randomUUID()+'.json'),value)}
}

// Production adapter names are resolved only through this run's exact receipts.
// Every destructive container invocation below uses a freshly inspected full ID.
export function auditedNativeDocker(registry:NativeRegistry,args:string[],execute:Execute):DockerResult{
 let index=0,config='',host=''
 while(args[index]?.startsWith('--')){
  const flag=args[index++],value=args[index++]
  assert.ok(value&&(flag==='--host'||flag==='--config'),'unsupported Docker global option')
  if(flag==='--host'){assert.equal(host,'');host=value}else{assert.equal(config,'');config=value}
 }
 const verb=args[index],prefix=args.slice(0,index),tail=args.slice(index+1)
 assert.ok(['build','info','create','start','inspect','rm','ps'].includes(verb),'unregistered Docker operation')
 if(verb==='build'){
  assert.ok(!host||host==='unix:///var/run/docker.sock','unexpected build endpoint')
  assert.ok(!process.env.DOCKER_HOST&&!process.env.DOCKER_CONTEXT,'ambient build endpoint forbidden')
  assert.equal(resolve(config||process.env.DOCKER_CONFIG||''),registry.owner.configRoot,'unregistered build config')
  assert.deepEqual(tail.filter(arg=>arg==='--rm'||arg.startsWith('--rm=')),['--rm=false'],'build intermediates must be retained')
  assert.deepEqual(tail.filter(arg=>arg==='--force-rm'||arg.startsWith('--force-rm=')),['--force-rm=false'],'build intermediates must be retained')
  return execute(args,false)
 }
 assert.equal(host,'unix:///var/run/docker.sock','unexpected Docker endpoint')
 assert.ok(config,'explicit Docker config required')
 if(resolve(config)!==registry.owner.configRoot)registry.registerConfig(config)
 const inspect=(target:string)=>{
  const result=execute([...prefix,'inspect','--type','container','--format','{{json .}}',target],true)
  return {result,info:result.status===0?JSON.parse(result.stdout??''):null}
 }
 if(verb==='create'){
  assert.ok(!tail.some(arg=>arg==='--label'||arg.startsWith('--label=')),'caller labels forbidden')
  assert.equal(tail.filter(arg=>arg==='--name').length,1)
  const name=tail[tail.indexOf('--name')+1],images=tail.filter(arg=>/^sha256:[a-f0-9]{64}$/.test(arg))
  assert.equal(images.length,1)
  const request=registry.reserveCreate(name,images[0])
  const result=execute([...prefix,'create','--label',`${ownerLabel}=${request.owner}`,'--label',`${receiptLabel}=${request.receipt}`,...tail],true)
  if(result.status===0){
   const id=(result.stdout??'').trim();assert.match(id,fullId)
   registry.event({action:'create-returned',name,receipt:request.receipt,id})
   const found=inspect(id);assert.equal(found.result.status,0,'created container identity unavailable')
   const created=registry.recordCreated(request,found.info);assert.equal(created.id,id)
  }else registry.event({action:'create-unconfirmed',name,receipt:request.receipt,status:result.status})
  return result
 }
 if(verb==='start'){
  assert.ok(tail.length===3&&tail[0]==='--attach'&&tail[1]==='--interactive','unexpected native start arguments')
  const request=registry.request(tail[2]),known=registry.created().find(entry=>entry.name===request.name)
  assert.ok(known,'start requires a completed full-ID create receipt')
  const found=inspect(known.id);assert.equal(found.result.status,0,'start identity unavailable')
  assert.equal(registry.verify(request,found.info).id,known.id)
  registry.event({action:'start-verified',id:known.id,receipt:request.receipt})
  return execute([...prefix,'start','--attach','--interactive',known.id],false)
 }
 if(verb==='rm'){
  assert.ok(tail.length===2&&tail[0]==='--force','only one exact container removal supported')
  const request=registry.request(tail[1]),known=registry.created().find(entry=>entry.name===request.name)
  const found=inspect(known?.id??request.name)
  if(found.result.status!==0){
   if(known&&/No such (?:container|object)/.test(found.result.stderr??'')){registry.event({action:'known-absent',id:known.id});return {status:0,stdout:''}}
   return found.result
  }
  const recovered=registry.recordCreated(request,found.info)
  if(fullId.test(tail[1]))assert.equal(tail[1],recovered.id,'ID substitution')
  const final=inspect(recovered.id);assert.equal(final.result.status,0,'removal identity unavailable')
  assert.equal(registry.verify(request,final.info).id,recovered.id)
  const result=execute([...prefix,'rm','--force',recovered.id],true)
  registry.event({action:'remove-result',id:recovered.id,status:result.status})
  return result
 }
 return execute(args,false)
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [directory,docker,...args]=process.argv.slice(2)
  assert.ok(directory&&docker&&resolve(docker)===docker)
  const result=auditedNativeDocker(new NativeRegistry(directory),args,(command,capture)=>{
   const r=spawnSync(docker,command,{encoding:'utf8',stdio:capture?['inherit','pipe','pipe']:'inherit',maxBuffer:4_500_000})
   return {status:r.status,stdout:r.stdout??'',stderr:r.stderr??''}
  })
  if(result.stdout)process.stdout.write(result.stdout)
  if(result.stderr)process.stderr.write(result.stderr)
  process.exitCode=result.status??1
 }catch{process.stderr.write('Native fixture registry refused an unconfirmed resource operation\n');process.exitCode=1}
}
