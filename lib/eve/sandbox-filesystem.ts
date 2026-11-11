import { posix } from 'node:path'
import { Bash, InMemoryFs, stdoutAsBytes, latin1FromBytes } from 'just-bash'
import type { SandboxConnection } from 'eve/sandbox/provider'

type Entry={path:string;kind:'directory'|'file'|'symlink';mode:number;mtime:number;content?:string;target?:string}
export type ScratchSnapshot={version:1;entries:Entry[];env:Record<string,string>}
export type ScratchMutation=<T>(work:(snapshot:ScratchSnapshot)=>Promise<{snapshot:ScratchSnapshot;value:T}>)=>Promise<T>
const maxBytes=64*1024*1024

export function emptyScratchSnapshot():ScratchSnapshot {
  return {version:1,entries:[],env:{HOME:'/home/eve',PATH:'/usr/bin:/bin',AI_AGENT:'eve'}}
}
async function restore(snapshot:ScratchSnapshot) {
  if(snapshot.version!==1)throw new Error('operationBindingConflict')
  const fs=new InMemoryFs({}, {maxTotalBytes:maxBytes})
  for(const entry of snapshot.entries.filter(e=>e.kind==='directory').sort((a,b)=>a.path.length-b.path.length))await fs.mkdir(entry.path,{recursive:true})
  for(const entry of snapshot.entries.filter(e=>e.kind!=='directory')) {
    await fs.mkdir(posix.dirname(entry.path),{recursive:true})
    if(entry.kind==='file')await fs.writeFile(entry.path,Buffer.from(entry.content??'','base64'))
    else await fs.symlink(entry.target??'',entry.path)
  }
  for(const entry of snapshot.entries)if(entry.kind!=='symlink'){await fs.chmod(entry.path,entry.mode);await fs.utimes(entry.path,new Date(entry.mtime),new Date(entry.mtime))}
  await fs.mkdir('/workspace',{recursive:true});await fs.mkdir('/home/eve',{recursive:true})
  return {fs,bash:new Bash({fs,cwd:'/workspace',env:{...snapshot.env},executionLimitProfile:'hardened',executionLimits:{maxExecutionTimeMs:10_000,maxOutputSize:1024*1024}})}
}
async function capture(fs:InMemoryFs,bash:Bash):Promise<ScratchSnapshot> {
  const entries:Entry[]=[]
  for(const path of fs.getAllPaths().sort()) {
    const stat=await fs.lstat(path),base={path,mode:stat.mode,mtime:stat.mtime.getTime()}
    if(stat.isDirectory)entries.push({...base,kind:'directory'})
    else if(stat.isSymbolicLink)entries.push({...base,kind:'symlink',target:await fs.readlink(path)})
    else entries.push({...base,kind:'file',content:Buffer.from(await fs.readFileBuffer(path)).toString('base64')})
  }
  return {version:1,entries,env:bash.getEnv()}
}

/** Public Eve connection backed only by JustBash's virtual filesystem. Every
 * operation commits independently; an idle connection owns no database client. */
export function scratchConnection(mutate:ScratchMutation):SandboxConnection {
  const processes=new Set<{controller:AbortController;done:Promise<unknown>}>()
  const change=<T>(work:(fs:InMemoryFs,bash:Bash)=>Promise<T>,signal?:AbortSignal)=>mutate(async snapshot=>{
    signal?.throwIfAborted()
    const {fs,bash}=await restore(snapshot)
    const value=await work(fs,bash)
    signal?.throwIfAborted()
    return {snapshot:await capture(fs,bash),value}
  })
  const stop=async()=>{for(const p of processes)p.controller.abort();await Promise.allSettled([...processes].map(p=>p.done))}
  return {
    workspaceRoot:'/workspace',
    async spawn({command,workingDirectory,env,signal,stdin}) {
      signal?.throwIfAborted()
      if(stdin)throw new Error('The JustBash sandbox does not support streaming stdin.')
      const controller=new AbortController(),abort=()=>controller.abort(signal?.reason)
      signal?.addEventListener('abort',abort,{once:true})
      const done=change(async(_fs,bash)=>bash.exec(command,{cwd:workingDirectory,env,signal:controller.signal}),controller.signal)
      const active={controller,done};processes.add(active)
      void done.finally(()=>{processes.delete(active);signal?.removeEventListener('abort',abort)}).catch(()=>{})
      const stream=(kind:'stdout'|'stderr')=>new ReadableStream<Uint8Array>({start(c){void done.then(result=>{const bytes=kind==='stdout'?Buffer.from(latin1FromBytes(stdoutAsBytes(result)),'latin1'):new TextEncoder().encode(result.stderr);if(bytes.length)c.enqueue(bytes);c.close()},error=>c.error(error))}})
      return {stdout:stream('stdout'),stderr:stream('stderr'),wait:async()=>({exitCode:(await done).exitCode}),kill:async()=>{controller.abort();await done.catch(()=>{})}}
    },
    readFile:({path,signal})=>change(async fs=>await fs.exists(path)?fs.readFileBuffer(path):null,signal),
    writeFiles:({files,signal})=>change(async fs=>{for(const file of files){await fs.mkdir(posix.dirname(file.path),{recursive:true});await fs.writeFile(file.path,file.content)}},signal),
    removePath:({path,force,recursive,signal})=>change(fs=>fs.rm(path,{force,recursive}),signal),
    stop,close:stop,
  }
}
