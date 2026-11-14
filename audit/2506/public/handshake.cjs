const { createRequire } = require('node:module')
const { realpathSync } = require('node:fs')
const assert = require('node:assert/strict')
const r = createRequire(realpathSync(require.resolve('wrangler/package.json')))
const { Miniflare, convertV4MiniflareOptions } = r('miniflare')
const ws = r('ws')
;(async () => {
  const worker = `import { DurableObject } from 'cloudflare:workers'
  class Base extends DurableObject {
    fetch() { const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]); return new Response(null, {status:101, webSocket:pair[0]}) }
  }
  export class Native extends Base {}
  export class Cleanup extends Base { webSocketClose(socket) { this.ctx.storage.kv.put('state',socket.readyState) } }
  export class Reply extends Base { webSocketClose(socket,code,reason) { if(code===1005 || code===1006) socket.close(); else socket.close(code,reason) } }
  export default {fetch(req,env) {return env[new URL(req.url).pathname.slice(1)].getByName('case').fetch(req)} }`
  const origin = { workers:[{name:'test',modules:true,script:worker,compatibilityDate:'2026-10-22',durableObjects:Object.fromEntries(['Native','Cleanup','Reply'].map(name=>[name,{className:name,useSQLite:true}]))}],cf:false,host:'127.0.0.1',port:0 }
  const app = new Miniflare(convertV4MiniflareOptions(origin))
  try {
    const base=(await app.ready).origin.replace(/^http:/,'ws:')
    for (const method of ['Reply','Native','Cleanup']) {
      const client=new ws(base+'/'+method)
      await new Promise((resolve,reject)=>{client.once('open',resolve);client.once('error',reject)})
      const frame=new Promise(resolve=>client._receiver.once('conclude',(code)=>resolve(code)))
      client.close(1000,'peer done')
      let timer
      const result=await Promise.race([frame,new Promise(resolve=>{timer=setTimeout(()=>resolve('no close frame in 2500 ms'),2500)})])
      clearTimeout(timer)
      console.log(method,result)
      client.terminate()
      if(method==='Reply') assert.equal(result,1000)
    }
  } finally {await app.dispose()}
})().catch(e=>{console.error(e);process.exitCode=1})
