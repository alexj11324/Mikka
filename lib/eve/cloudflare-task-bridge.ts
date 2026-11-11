import 'server-only'
import { newWebSocketRpcSession, type RpcTarget } from 'capnweb'
import { WebSocket } from 'undici'
import { cloudflareTaskConnection, type TaskMachineGrant, type TaskWorkspaceBinding } from './cloudflare-task-connection'

const origin='http://task-machine.internal'
interface ProcessHandle extends RpcTarget {
  wait():Promise<{exitCode:number}>
  kill():Promise<unknown>
}
interface Spawn extends RpcTarget {
  spawn(grant:TaskMachineGrant, options:Parameters<TaskWorkspaceBinding['spawn']>[1]):Promise<{
    pid:number; stdout:ReadableStream<Uint8Array>; stderr:ReadableStream<Uint8Array>
    stdin?:WritableStream<Uint8Array>; handle:ProcessHandle
  }>
}

function token() {
  const capability=process.env.MIKKA_TASK_MACHINE_BRIDGE_TOKEN
  if (!capability) throw Error('Private task machine bridge unavailable')
  return 'Bearer '+capability
}
async function post(path:string, body:unknown) {
  const response=await fetch(origin + '/v1/'+path,{method:'POST',redirect:'error',cache:'no-store',
    headers:{'content-type':'application/json',authorization:token()},body:JSON.stringify(body),signal:AbortSignal.timeout(70_000)})
  if (!response.ok) { await response.body?.cancel(); throw Error('Private task machine '+path+' HTTP '+response.status) }
  return response
}

// Only the trusted Node host has the interceptor capability. Every request
// includes the immutable owner/workspace/task/repository/run/operation tuple.
const binding:TaskWorkspaceBinding={
  async spawn(grant,options) {
    const socket=new WebSocket('ws://task-machine.internal/v1/process',{headers:{authorization:token()}})
    const remote=newWebSocketRpcSession<Spawn>(socket as unknown as globalThis.WebSocket)
    try {
      const proc=await remote.spawn(grant,options)
      // wait can precede consumer reads. Keep the socket open until the
      // output channels drain; EOF/kill/connection loss stay provider-owned.
      let channels=2, settled=false
      const release=()=>{if (settled && channels===0) socket.close()}
      const follow=(stream:ReadableStream<Uint8Array>)=>{
        const reader=stream.getReader()
        let finished=false
        const finish=()=>{if (!finished) { finished=true; channels--; release() }}
        return new ReadableStream<Uint8Array>({
          async pull(controller){
            try {const chunk=await reader.read();if(chunk.done){finish();controller.close()}else controller.enqueue(chunk.value)}
            catch(error){finish();controller.error(error)}
          },
          async cancel(reason){try{await reader.cancel(reason)}finally{finish()}},
        })
      }
      const done=Promise.resolve(proc.handle.wait()).finally(()=>{settled=true;release()})
      void done.catch(()=>{})
      return {pid:proc.pid,stdout:follow(proc.stdout),stderr:follow(proc.stderr),...(proc.stdin?{stdin:proc.stdin}:{}),
        handle:{wait:()=>done,kill:async()=>{await proc.handle.kill()}}}
    } catch(error){socket.close();throw error}
  },
  async readFile(grant,path){
    const r=await post('read-file',{grant,path})
    return r.status===204?null:new Uint8Array(await r.arrayBuffer())
  },
  async writeFile(grant,path,bytes){await (await post('write-file',{grant,path,base64:Buffer.from(bytes).toString('base64')})).body?.cancel()},
  async removePath(grant,path,options){await (await post('remove-path',{grant,path,...options})).body?.cancel()},
  async park(grant){await (await post('park',{grant})).body?.cancel()},
}

/** Acquire only after authoritative Task/Run admission. A chat, history read,
 * or client-supplied workspace location cannot call this adapter directly. */
export async function openCloudflareTaskConnection(grant:TaskMachineGrant){
  await (await post('open',{grant})).body?.cancel()
  return cloudflareTaskConnection(binding,grant)
}
