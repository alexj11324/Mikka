import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {z} from 'zod'
import type {GroupReviewAssignment,GroupReviewOutput} from '../runs/group-review-worker'

// Local immutable images only; no implicit pull, provider credentials or host
// auth/home/repository mounts. Network stays off pending approved model egress.
export const groupReviewImages=z.object({claude_code:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),codex:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()}).strict().refine(x=>!!(x.claude_code||x.codex),'No group CLI image configured')
export type GroupReviewImages=z.infer<typeof groupReviewImages>
export type NativeGroupProcessor=((assignment:GroupReviewAssignment,signal:AbortSignal)=>Promise<GroupReviewOutput>)&{dispose:()=>Promise<void>}
const runnerPath=resolve(dirname(fileURLToPath(import.meta.url)),'../agents/group-review-cli.mjs')
const exec=promisify(execFile)
const output=z.object({body:z.string().trim().min(1).max(32000),content:z.string().max(1_000_000).nullable()}).strict()
const artifact=z.object({artifactId:z.uuid(),baseVersionId:z.uuid(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough()
const probeSchema=z.object({version:z.string(),help:z.string(),features:z.string()}).strict()
interface DockerRuntime {args:string[];env:NodeJS.ProcessEnv}
function docker(runtime:DockerRuntime,args:string[]){return exec('docker',[...runtime.args,...args],{timeout:5000,env:runtime.env})}
async function container(runtime:DockerRuntime,image:string,input:unknown,signal:AbortSignal){
 const name='mikka-group-cli-'+randomUUID(),uid=process.getuid?.()??65534,gid=process.getgid?.()??65534
 if(uid===0)throw Error('Group CLI host must be unprivileged')
 const child=spawn('docker',[...runtime.args,'run','--pull=never','--rm','--interactive','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',`${uid}:${gid}`,'--pids-limit','64','--memory','1g','--cpus','1','--tmpfs',`/scratch:rw,noexec,nosuid,nodev,size=64m,uid=${uid},gid=${gid},mode=700`,'--mount',`type=bind,source=${runnerPath},target=/opt/mikka-group-runner.mjs,readonly`,'--entrypoint','/usr/local/bin/node',image,'/opt/mikka-group-runner.mjs'],{env:runtime.env,stdio:['pipe','pipe','pipe']})
 const chunks:Buffer[]=[]
 let outSize=0,errSize=0,failed=false
 const kill=()=>{failed=true;void docker(runtime,['rm','--force',name]).catch(()=>{});child.kill('SIGKILL')}
 const abort=()=>kill();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)kill()
 child.stdout.on('data',d=>{outSize+=d.length;if(outSize>4_300_000)kill();else chunks.push(d)})
 child.stderr.on('data',d=>{errSize+=d.length;if(errSize>64000)kill()})
 child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input))
 try{
  // exit does not guarantee all stdio is drained; close does.
  await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0&&!failed?resolve():reject(Error('Isolated group CLI failed or exceeded limits')))})
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
 }finally{signal.removeEventListener('abort',abort);await docker(runtime,['rm','--force',name]).catch(()=>{})}
}
export async function createNativeGroupProcessor(value:unknown):Promise<NativeGroupProcessor>{
 if(process.platform!=='linux')throw Error('Group CLI isolation requires Linux Docker')
 const images=groupReviewImages.parse(value)
 const configDir=await mkdtemp(join(tmpdir(),'mikka-group-docker-'))
 // Every command, including cancellation and readiness, targets the SAME
 // local socket and fresh config. Never inherit DOCKER_HOST/context/auth.
 const runtime:DockerRuntime={args:['--host','unix:///var/run/docker.sock','--config',configDir],env:{PATH:process.env.PATH,NODE_ENV:'production',DOCKER_CONFIG:configDir}}
 const active=new Set<Promise<unknown>>()
 let disposed=false
 const invoke=(image:string,input:unknown,signal:AbortSignal)=>{
  if(disposed)return Promise.reject(new Error('Group CLI runtime disposed'))
  const task=container(runtime,image,input,signal);active.add(task)
  void task.then(()=>active.delete(task),()=>active.delete(task))
  return task
 }
 const dispose=async()=>{disposed=true;await Promise.allSettled([...active]);await rm(configDir,{recursive:true,force:true})}
 try{
  const info=await docker(runtime,['info','--format','{{.OSType}}'])
  if(info.stdout.trim()!=='linux')throw Error('Linux Docker required')
  for(const [h,image]of Object.entries(images)){
   const probe=probeSchema.parse(await invoke(image,{action:'probe',harness:h},AbortSignal.timeout(15000)))
   if(h==='claude_code'){
    if(!/^2\.1\.290 \(Claude Code\)$/.test(probe.version))throw Error('Unsupported Claude Code group CLI version (2.1.290 contract)')
    for(const flag of ['--bare','--restricted','--tools','--disallowedTools','--strict-mcp-config','--mcp-config','--output-format','--setting-sources','--no-session-persistence','--json-schema','--max-turns','--system-prompt'])if(!probe.help.includes(flag))throw Error('Required Claude group CLI capability unavailable')
   }else{
    if(!/^codex-cli 0\.162\.1$/.test(probe.version))throw Error('Unsupported Codex group CLI version (0.162.1 contract)')
    for(const feature of ['shell_tool','apply_patch_freeform','multi_agent','multi_agent_v2']){
     const rows=probe.features.split('\n').map(line=>line.trim().split(/\s+/)).filter(parts=>parts[0]===feature)
     if(rows.length!==1||rows[0].at(-1)!=='false')throw Error('Required Codex tool-disable capability unavailable')
    }
    for(const flag of ['--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','--json','--output-schema','--output-last-message','--config'])if(!probe.help.includes(flag))throw Error('Required Codex group CLI capability unavailable')
   }
  }
  return Object.assign(async(assignment:GroupReviewAssignment,signal:AbortSignal):Promise<GroupReviewOutput>=>{
   const image=images[assignment.harness]
   if(!image)throw Error('No compatible group CLI image for the authenticated harness')
   const parsed=output.parse(await invoke(image,{action:'execute',harness:assignment.harness,envelope:assignment.envelope},signal))
   if(parsed.content===null)return{body:parsed.body}
   const data=z.object({artifact:artifact}).passthrough().parse(assignment.envelope.untrustedData)
   return{body:parsed.body,proposal:{artifactId:data.artifact.artifactId,baseVersionId:data.artifact.baseVersionId,baseHash:data.artifact.hash,content:parsed.content}}
  },{dispose})
 }catch(error){await dispose();throw error}
}
