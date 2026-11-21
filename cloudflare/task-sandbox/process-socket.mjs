import { newWebSocketRpcSession, RpcTarget } from 'capnweb'
import { machineGrant } from './grant.mjs'

class ProcessHandle extends RpcTarget {
  #handle
  constructor(handle) { super(); this.#handle=handle }
  wait() { return this.#handle.wait() }
  kill() { return this.#handle.kill() }
}

/** Called after the private Node-container egress interceptor authenticates
 * the bridge request. This capability can start one process in one leased
 * product machine. It cannot create a lease, change owners or touch receipts. */
export function handleTaskProcessSocket(request, binding) {
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
      new URL(request.url).pathname !== '/v1/process') return new Response(null,{status:404})
  const {0:client,1:server}=new WebSocketPair()
  let used=false, disconnected=false, active
  const cleanup=()=>{
    disconnected=true
    if (active) void active.kill().catch(()=>{})
  }
  const api=new class extends RpcTarget {
    async spawn(identity, options) {
      if (used || disconnected) throw Error('Task process socket unavailable')
      used=true
      const grant=machineGrant(identity)
      const proc=await binding.spawn(grant, options)
      active=proc.handle
      if (disconnected) { await active.kill(); throw Error('Task process socket closed') }
      // Leave disposal of the response (and its streams) to the calling API.
      return {pid:proc.pid,stdout:proc.stdout,stderr:proc.stderr,...(proc.stdin?{stdin:proc.stdin}:{}),
        handle:new ProcessHandle(active)}
    }
  }()
  server.accept()
  server.addEventListener('close',cleanup,{once:true})
  server.addEventListener('error',cleanup,{once:true})
  newWebSocketRpcSession(server,api)
  return new Response(null,{status:101,webSocket:client})
}
