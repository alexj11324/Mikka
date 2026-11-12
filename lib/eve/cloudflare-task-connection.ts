import type { SandboxConnection } from 'eve/sandbox/provider'

type SandboxProcess = Awaited<ReturnType<SandboxConnection['spawn']>>

export type TaskMachineGrant = Readonly<{
  ownerId:string; workspaceId:string; taskId:string; repositoryKey:string
  runId:string; operationId:string; expiresAt:number
}>

type SpawnOptions = Parameters<SandboxConnection['spawn']>[0]
type RemoteProcess = Pick<SandboxProcess, 'stdout'|'stderr'|'stdin'|'pid'> & {
  handle: Pick<SandboxProcess, 'wait'|'kill'>
}
export interface TaskWorkspaceBinding {
  spawn(grant:TaskMachineGrant, options:Omit<SpawnOptions,'signal'>):Promise<RemoteProcess>
  readFile(grant:TaskMachineGrant, path:string):Promise<Uint8Array|null>
  writeFile(grant:TaskMachineGrant, path:string, contents:Uint8Array):Promise<unknown>
  removePath(grant:TaskMachineGrant, path:string, options:{force?:boolean;recursive?:boolean}):Promise<unknown>
  park(grant:TaskMachineGrant):Promise<unknown>
}

/** Eve owns the SandboxSession API. This adapter supplies the byte-level connection
 * to an already admitted, exclusive Mikka Coding Run. Opening a chat or reading
 * history does not allocate this machine. Never receive the grant from a client. */
export function cloudflareTaskConnection(binding:TaskWorkspaceBinding, grant:TaskMachineGrant):SandboxConnection {
  const active = new Set<Pick<SandboxProcess,'kill'>>()
  let closed = false
  const available = (signal?:AbortSignal) => {
    signal?.throwIfAborted()
    if (closed) throw Error('Task machine connection closed')
  }
  return {
    workspaceRoot:'/workspace',
    async spawn({signal,...options}) {
      available(signal)
      const {handle,...streams} = await binding.spawn(grant,options)
      const kill = async () => { await handle.kill() }
      const onAbort = () => { void kill().catch(()=>{}) }
      active.add(handle)
      const done = Promise.resolve(handle.wait()).finally(()=>{
        active.delete(handle)
        signal?.removeEventListener('abort',onAbort)
      })
      void done.catch(()=>{})
      signal?.addEventListener('abort',onAbort,{once:true})
      if (closed || signal?.aborted) { await kill(); available(signal) }
      return {...streams,wait:()=>done,kill}
    },
    async readFile({path,signal}) {
      available(signal)
      return binding.readFile(grant,path)
    },
    async writeFiles({files,signal}) {
      for (const {path,content} of files) {
        available(signal)
        await binding.writeFile(grant,path,content)
      }
    },
    async removePath({path,force,recursive,signal}) {
      available(signal)
      await binding.removePath(grant,path,{force,recursive})
    },
    async stop() { closed=true; await binding.park(grant) },
    async close() {
      closed=true
      await Promise.all([...active].map(p=>p.kill()))
    },
  }
}
