import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile,open} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import {Client} from 'eve/client'
import {emptySessionView,foldEvents,session as sessionObservation} from 'eve/events'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const serverId='018f0000-0000-7000-8000-000000000001'
const qualifiedName=`mcp-${serverId}__read_wiki_structure`
const description='Synthetic public wiki topics for the native connection regression'

async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`}
async function stop(child){
 if(!child||child.exitCode!==null)return
 const exited=once(child,'exit');child.kill('SIGTERM')
 if(!await Promise.race([exited.then(()=>true),delay(3000).then(()=>false)])){child.kill('SIGKILL');await exited}
}
async function command(args,options){
 const child=spawn(process.execPath,args,options)
 const [code]=await once(child,'exit')
 assert.equal(code,0,'public Eve build failed: '+(code===0?'':(await readFile(join(options.cwd,'../../build.log'),'utf8')).slice(-5000)))
}

test('production personal MCP definitions resolve through the actual rc.9 HTTP runtime', {timeout:180000}, async t=>{
 const fixture=await mkdtemp(join(tmpdir(),'mikka-eve-mcp-names-'))
 let eve,buildLog,runtimeLog
 const sockets=new Set(),streams=new Map(),requests=[]
 const rpc=(body)=>{
  if(body.id===undefined)return null
  if(body.method==='initialize')return {jsonrpc:'2.0',id:body.id,result:{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'mikka-native-mcp-regression',version:'1'}}}
  if(body.method==='tools/list')return {jsonrpc:'2.0',id:body.id,result:{tools:[{name:'read_wiki_structure',description,inputSchema:{type:'object',properties:{repoName:{type:'string'}},required:['repoName'],additionalProperties:false}}]}}
  if(body.method==='tools/call'){
   assert.equal(body.params.name,'read_wiki_structure');assert.deepEqual(body.params.arguments,{repoName:'vercel/ai'})
   return {jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:'- Overview\n- Core Concepts\n- Streaming and tool execution'}]}}
  }
  return {jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'Unknown fixture method'}}
 }
 const mcp=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://fixture')
   assert.equal(req.headers['x-fixture-authority'],'revision-7')
   if(url.pathname==='/sse'&&req.method==='POST'){res.writeHead(405);res.end();return}
   if(url.pathname==='/sse'&&req.method==='GET'){
    const id=String(streams.size+1);streams.set(id,res)
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'})
    res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`)
    req.on('close',()=>streams.delete(id));return
   }
   if(req.method!=='POST'){res.writeHead(405);res.end();return}
   const chunks=[];for await(const chunk of req)chunks.push(chunk)
   const body=JSON.parse(Buffer.concat(chunks).toString());requests.push({path:url.pathname,method:body.method})
   const reply=rpc(body)
   if(url.pathname==='/messages'){
    const stream=streams.get(url.searchParams.get('sessionId'))
    assert.ok(stream,'SSE connection must have completed its endpoint handshake')
    if(reply)stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
    res.writeHead(202);res.end();return
   }
   if(!reply){res.writeHead(202);res.end();return}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(reply))
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}))}
 })
 mcp.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
 t.after(async()=>{
  await stop(eve);await buildLog?.close();await runtimeLog?.close()
  for(const stream of streams.values())stream.end()
  for(const socket of sockets)socket.destroy()
  await new Promise(resolve=>mcp.close(resolve));await rm(fixture,{recursive:true,force:true})
 })
 const mcpOrigin=await listen(mcp)
 const portProbe=createServer();const eveOrigin=await listen(portProbe);await new Promise(resolve=>portProbe.close(resolve))
 const agent=join(fixture,'apps/eve/agent'),cwd=join(fixture,'apps/eve')
 await mkdir(join(agent,'connections'),{recursive:true});await mkdir(join(agent,'channels'),{recursive:true})
 await mkdir(join(fixture,'lib/eve'),{recursive:true});await mkdir(join(fixture,'lib/plugins'),{recursive:true})
 await writeFile(join(fixture,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{eve:'1.0.0-rc.9'}}))
 await writeFile(join(cwd,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{eve:'1.0.0-rc.9'}}))
 await writeFile(join(cwd,'tsconfig.json'),JSON.stringify({extends:'../../tsconfig.json'}))
 await writeFile(join(fixture,'tsconfig.json'),JSON.stringify({compilerOptions:{module:'ESNext',target:'ES2022',moduleResolution:'Bundler',strict:true,skipLibCheck:true}}))
 await mkdir(join(fixture,'node_modules'))
 for(const name of await readdir(join(root,'node_modules')))if(name!=='.cache')await symlink(join(root,'node_modules',name),join(fixture,'node_modules',name))
 // Keep the complete production resolver unchanged: only its product dependencies are synthetic.
 await writeFile(join(agent,'connections/personal.ts'),await readFile(join(root,'apps/eve/agent/connections/personal.ts')))
 await writeFile(join(fixture,'lib/eve/evaluation-context.ts'),await readFile(join(root,'lib/eve/evaluation-context.ts')))
 await writeFile(join(agent,'instructions.md'),'Use only the requested synthetic read-only MCP tool; this is an offline runtime contract test.')
 await writeFile(join(agent,'agent.ts'),`import {defineAgent} from 'eve'
import {mockModel} from 'eve/evals'
export default defineAgent({defaultTools:false,model:mockModel(({lastUserMessage,toolResults})=>{
 if(['http','sse'].includes(lastUserMessage??'')&&toolResults.length===0)return {toolCalls:[{name:'eve__tool',input:{name:'${qualifiedName}',input:{repoName:'vercel/ai'}}}]}
 return 'Synthetic native connection turn completed'
}),limits:{sessionTimeoutMs:false},experimental:{workflow:{retention:'default'}}})
`)
 await writeFile(join(agent,'channels/eve.ts'),`import {eveChannel} from 'eve/channels/eve'
export default eveChannel({auth(request){return {authenticator:'fixture',principalType:'user',principalId:'fixture-owner',attributes:{mode:request.headers.get('x-fixture-mode')}}}})
`)
 await writeFile(join(fixture,'lib/eve/runtime.ts'),`export async function executionForSession(ctx){
 const mode=ctx.session.auth.current.attributes.mode
 return {scope:{ownerId:'fixture-owner',workspaceId:'018f0000-0000-7000-8000-000000000002'},scheduledRead:null,
 execution:{snapshot:{personalPlugins:{servers:mode==='none'?[]:[{id:'${serverId}',name:mode,revision:7}],
 mcpAuthority:{requester:'fixture-owner',servers:[{id:'${serverId}',revision:7,name:mode}]}}}}}
}
`)
 await writeFile(join(fixture,'lib/plugins/runtime.ts'),`export const personalPlugins={
 async snapshot(){throw Error('A frozen execution snapshot is required')},
 async mcpConnection(owner,id,revision,authority){
 if(owner!=='fixture-owner'||id!=='${serverId}'||revision!==7||authority?.requester!==owner||authority?.servers[0].id!==id)throw Error('Fixture authority mismatch')
 const transport=authority.servers[0].name
 return {name:'Synthetic wiki',transport,url:process.env.FIXTURE_MCP_ORIGIN+(transport==='sse'?'/sse':'/mcp'),revision,headers:{'x-fixture-authority':'revision-7'}}
 }}
`)
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'production',NITRO_PRESET:'node-server',WORKFLOW_LOCAL_BASE_URL:eveOrigin}
 buildLog=await open(join(fixture,'build.log'),'w')
 await command([join(root,'node_modules/eve/bin/eve.js'),'build'],{cwd,env,stdio:['ignore',buildLog.fd,buildLog.fd]})
 // One real Node/local World serves every case; its synthetic endpoint is loopback only.
 runtimeLog=await open(join(fixture,'runtime.log'),'w')
 eve=spawn(process.execPath,[join(root,'node_modules/eve/bin/eve.js'),'start','--host','127.0.0.1','--port',new URL(eveOrigin).port],
   {cwd,env:{...env,FIXTURE_MCP_ORIGIN:mcpOrigin},stdio:['ignore',runtimeLog.fd,runtimeLog.fd]})
  const deadline=Date.now()+30000
  while(true){
   assert.equal(eve.exitCode,null,'public Eve runtime exited before health')
   try{if((await fetch(eveOrigin+'/eve/v1/health',{signal:AbortSignal.timeout(500)})).ok)break}catch{}
   assert.ok(Date.now()<deadline,'public Eve health timed out');await delay(100)
  }
 for(const mode of ['none','http','sse','stdio'])await t.test(mode,async()=>{
  const client=new Client({baseUrl:eveOrigin,headers:{'x-fixture-mode':mode}}),before=requests.length
  const {session,delivery}=await client.sessions.create({message:mode})
  const result=await delivery.result({signal:AbortSignal.timeout(30000)})
  const snapshot=await session.snapshot({signal:AbortSignal.timeout(10000)})
  assert.equal(result.status,'completed',JSON.stringify(snapshot.events.filter(event=>event.type==='turn.settled').map(event=>event.data.error)))
  assert.ok(snapshot.events.some(event=>event.type==='model.started'))
  const calls=snapshot.events.filter(event=>event.type==='call.requested')
  if(mode==='http'||mode==='sse'){
   assert.equal(calls.length,1);assert.equal(calls[0].data.capability.name,qualifiedName)
   assert.deepEqual(calls[0].data.input,{repoName:'vercel/ai'})
   const settled=snapshot.events.find(event=>event.type==='call.settled'&&event.data.callId===calls[0].data.callId)
   assert.equal(settled.data.outcome,'completed');assert.match(settled.data.output,/Core Concepts/)
   assert.equal(requests.slice(before).filter(row=>row.method==='tools/call').length,1)
   if(mode==='sse')assert.ok(requests.slice(before).some(row=>row.path==='/messages'))
  }else{assert.equal(calls.length,0);assert.equal(requests.length,before)}
  // Some rc.9 control delivery reads finish before the terminal commit; the snapshot is authoritative.
  const end=await session.end({reason:'fixture complete'})
  await end.result({signal:AbortSignal.timeout(10000)}).catch(()=>{})
  for await(const event of session.stream({startIndex:snapshot.session.streamIndex,signal:AbortSignal.timeout(10000)})){if(event.type==='session.ended')break}
  assert.equal(sessionObservation(foldEvents(emptySessionView(),(await session.snapshot()).events)).status,'ended')
 })
})
