import assert from 'node:assert/strict'
import {mock,test} from 'node:test'

let deviceOwner:string|null=null,sessionOwner:string|null=null,ownershipReads=0,effects=0
const forbidden=()=>{effects++;throw Error('Retired runtime cannot execute')}
const stub=(path:string,namedExports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{namedExports})
stub('../device-route.ts',{withDeviceRoute:(handler:unknown)=>handler})
stub('../device-link.ts',{authenticateDevice:async()=>deviceOwner?{userId:deviceOwner}:null,ownsDevice:async(deviceId:string,owner:string)=>{ownershipReads++;return deviceId==='owned-device'&&owner==='owner'}})
stub('../api-auth.ts',{auth:{api:{getSession:async()=>sessionOwner?{user:{id:sessionOwner}}:null}}})
stub('./native.ts',{nativeCoordinatorStore:new Proxy({},{get:()=>forbidden})})
const deviceRoute=await import('../../app/v1/devices/[deviceId]/coordinator/route')
const runtimeRoute=await import('../../app/api/coordinator/runtime/route')
const params=(deviceId:string)=>({params:Promise.resolve({deviceId})})
const request=(body:unknown)=>new Request('http://localhost/mikka/v1/devices/owned-device/coordinator',{method:'POST',body:JSON.stringify(body)})

test('old device messages authenticate and retire without parsing or dispatching a model job',async()=>{
 const unauthorized=await deviceRoute.POST(request({operation:'claim'}),params('owned-device'))
 assert.equal(unauthorized.status,401);assert.equal(ownershipReads,0)
 deviceOwner='owner'
 assert.equal((await deviceRoute.POST(request({operation:'claim'}),params('foreign-device'))).status,404)
 for(const operation of ['claim','submit','result']){
  const input=request({operation,context:'private legacy context',command:{type:'complete',text:'Unpublished old reply'}})
  const response=await deviceRoute.POST(input,params('owned-device'))
  assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'notEnabled'})
  assert.equal(input.bodyUsed,false,'retirement never parses model/tool input')
 }
 assert.equal(effects,0)
})
test('old runtime discovery keeps its wire shape but no selector can activate another engine',async()=>{
 const input=new Request('http://localhost/mikka/api/coordinator/runtime')
 assert.equal((await runtimeRoute.GET(input)).status,401)
 assert.equal((await runtimeRoute.PUT(input)).status,401)
 sessionOwner='owner'
 const discovered=await runtimeRoute.GET(input)
 assert.equal(discovered.headers.get('cache-control'),'private, no-store')
 assert.deepEqual(await discovered.json(),{available:false,runtime:{harness:'ai_sdk'}})
 for(const harness of ['claude_code','codex','ai_sdk']){
  const mutation=new Request(input.url,{method:'PUT',body:JSON.stringify({harness,deviceId:'owned-device'})})
  assert.equal((await runtimeRoute.PUT(mutation)).status,404);assert.equal(mutation.bodyUsed,false)
 }
 assert.equal(effects,0)
})
