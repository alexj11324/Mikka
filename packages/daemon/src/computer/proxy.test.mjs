import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {createInterface} from 'node:readline'
import {fileURLToPath} from 'node:url'

test('actual MCP proxy removes standard transport metadata while keeping action validation strict', async()=>{
 const calls=[], sockets=new Set()
 const server=createServer(socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket))
  createInterface({input:socket}).once('line',line=>{
   const frame=JSON.parse(line);calls.push(frame)
   socket.end(JSON.stringify(frame.token==='synthetic-proxy-token'?{result:{content:[{type:'text',text:'synthetic-state'}]}}:{error:'denied'})+'\n')
  })
 })
 await new Promise(done=>server.listen(0,'127.0.0.1',done))
 const endpoint=`tcp://127.0.0.1:${server.address().port}`
 const child=spawn(process.execPath,[fileURLToPath(new URL('./proxy.mjs',import.meta.url)),endpoint,'synthetic-proxy-token'],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']})
 const replies=new Map(), waiting=new Map()
 const lines=createInterface({input:child.stdout})
 lines.on('line',line=>{const frame=JSON.parse(line),resolve=waiting.get(frame.id);if(resolve){waiting.delete(frame.id);resolve(frame)}else replies.set(frame.id,frame)})
 const exited=new Promise(done=>child.once('exit',done))
 let id=0
 async function call(params){
  const key=++id;let timer
  const answer=replies.has(key)?Promise.resolve(replies.get(key)):new Promise(done=>waiting.set(key,done))
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method:'tools/call',params})+'\n')
  try{return await Promise.race([answer,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('proxy response timeout')),3000))])}
  finally{clearTimeout(timer)}
 }
 try{
  const action={name:'get_desktop_state',arguments:{}}
  const accepted=await call({...action,_meta:{'claudecode/toolUseId':'synthetic-tool-use',progressToken:2}})
  assert.equal(accepted.result.isError,undefined)
  assert.deepEqual(calls,[{token:'synthetic-proxy-token',call:action}])
  for(const params of [{...action,_meta:null},{...action,_meta:[]},{...action,permission:'allow'},{...action,arguments:{permission:'allow'}}])assert.equal((await call(params)).result.isError,true)
  assert.equal(calls.length,1,'invalid envelope/action never reaches broker')
 }finally{
  child.stdin.end();child.kill('SIGTERM');await exited;lines.close()
  for(const socket of sockets)socket.destroy()
  await new Promise(done=>server.close(done))
 }
})
