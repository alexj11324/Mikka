import { defineSandboxProvider, type SandboxPrepareContext, type SandboxSessionContext, type SandboxSessionEndOptions } from 'eve/sandbox/provider'
import { z } from 'zod'
import { eveScopeSchema,scopeFromAuth } from './scope'
import { emptyScratchSnapshot,scratchConnection,type ScratchSnapshot } from './sandbox-filesystem'
import type { ScratchIdentity,ScratchStore } from './sandbox-store'

type Artifact={version:1;templateKey:string;snapshot:ScratchSnapshot}
type State={version:1;sessionId:string;scope:z.infer<typeof eveScopeSchema>}
const stateSchema=z.object({version:z.literal(1),sessionId:z.string().min(1),scope:eveScopeSchema}).strict()
function identity(ctx:SandboxSessionContext,state?:Readonly<State>):ScratchIdentity {
  if(state) {
    const saved=stateSchema.parse(state)
    if(saved.sessionId!==ctx.session.id)throw new Error('workspaceAccessDenied')
    const auth=ctx.session.auth.current??ctx.session.auth.initiator
    if(auth&&JSON.stringify(scopeFromAuth(auth))!==JSON.stringify(saved.scope))throw new Error('workspaceAccessDenied')
    return {sessionId:saved.sessionId,scope:saved.scope}
  }
  return {sessionId:ctx.session.id,scope:scopeFromAuth(ctx.session.auth.current??ctx.session.auth.initiator)}
}

/** Public provider implementation: portable JSON preparation and the existing
 * application database replace machine-local template directories. */
export function createPortableScratchProvider(getStore:()=>Promise<ScratchStore>) {
  const connect=(id:ScratchIdentity)=>scratchConnection(async work=>(await getStore()).mutate(id,undefined,work))
  return {
    async prepare(ctx:SandboxPrepareContext):Promise<Artifact> {
      let snapshot=emptyScratchSnapshot()
      const connection=scratchConnection(async work=>{const result=await work(snapshot);snapshot=result.snapshot;return result.value})
      try {await ctx.populate(connection)}finally {await connection.close?.()}
      return {version:1,templateKey:ctx.templateKey({version:1,engine:'just-bash-3.6.0'}),snapshot}
    },
    async start(ctx:SandboxSessionContext,_options:undefined,artifact:Readonly<Artifact>) {
      if(artifact.version!==1||artifact.snapshot.version!==1)throw new Error('operationBindingConflict')
      const id=identity(ctx),store=await getStore()
      await store.mutate(id,artifact.snapshot,async snapshot=>({snapshot,value:undefined}))
      return {connection:connect(id),state:{version:1 as const,...id}}
    },
    async resume(ctx:SandboxSessionContext,_artifact:Readonly<Artifact>,state:Readonly<State>) {
      const id=identity(ctx,state)
      await (await getStore()).mutate(id,undefined,async snapshot=>({snapshot,value:undefined}))
      return connect(id)
    },
    async onSessionEnd(ctx:SandboxSessionContext,state:Readonly<State>|null,_options:SandboxSessionEndOptions) {
      // Eve calls cleanup even when a session never acquired a sandbox.
      if(!state&&!ctx.session.auth.current&&!ctx.session.auth.initiator)return
      const id=identity(ctx,state??undefined)
      await (await getStore()).remove(id)
    },
  }
}
export const PortableScratchSandbox=defineSandboxProvider({
  name:'mikka-just-bash',
  environment:()=>createPortableScratchProvider(async()=>{
    const [{pool,withDatabaseClient},{assertEveScope},{scratchStore}]=await Promise.all([import('../db'),import('./scope'),import('./sandbox-store')])
    return scratchStore(pool,(scope,tx)=>withDatabaseClient(tx,()=>assertEveScope(scope)))
  }),
})
