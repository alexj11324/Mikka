import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile, spawn } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { claudeAppServers } from '../src/adapters/claude'
import { codexAppArgs } from '../src/adapters/codex'
import type { RunApps } from '../src/agents/run-apps'
import { codexMcpServer } from '../src/agents/run-apps'

const claude = process.env.MIKKA_NATIVE_CLAUDE_BIN, codex = process.env.MIKKA_NATIVE_CODEX_BIN
if (process.env.REQUIRE_NATIVE_CLI_TESTS === '1' && (!claude || !codex)) throw new Error('Both pinned native CLI binaries are required')
const run = promisify(execFile)

// This exercises the actual CLIs' MCP configuration/initialization only. No model request is sent.
test('official Claude and Codex accept the task native configuration and Claude initializes real STDIO', { skip: !claude || !codex, timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(),'mikka-native-mcp-cli-'))
  try {
    const fixture = join(directory,'server.mjs'), receipt = join(directory,'receipt')
    await writeFile(fixture, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';const lines=createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);if(!('id' in m))return;appendFileSync(process.env.FIXTURE_RECEIPT,m.method+'\\n');const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'native-fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object',properties:{}}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`)
    const apps: RunApps = {token:'',apps:[],servers:[
      {name:'mcp_stdio',transport:'stdio',command:process.execPath,args:[fixture],cwd:directory,env:{FIXTURE_RECEIPT:receipt,SERVICE_TOKEN:'synthetic-task-token'}},
      {name:'mcp_http',transport:'http',url:'https://mcp.acme.dev/rpc',headers:{'X-Account':'fixture',Authorization:'Bearer synthetic-task-token'}},
    ]}
    const env = {...process.env,CLAUDE_CONFIG_DIR:join(directory,'claude'),CODEX_HOME:join(directory,'codex'),DISABLE_NONESSENTIAL_TRAFFIC:'1'}
    await Promise.all([mkdir(env.CLAUDE_CONFIG_DIR),mkdir(env.CODEX_HOME)])
    const args = codexAppArgs(apps)
    const listed = await run(codex!,['mcp','list','--json',...args],{cwd:directory,env,timeout:15_000})
    const entries = JSON.parse(listed.stdout) as {name:string;transport:{type:string}}[]
    assert.equal(entries.find(entry=>entry.name==='mcp_stdio')?.transport.type,'stdio')
    assert.equal(entries.find(entry=>entry.name==='mcp_http')?.transport.type,'streamable_http')
    const config = claudeAppServers(apps).mcp_stdio
    await run(claude!,['mcp','add-json','--scope','local','mcp_stdio',JSON.stringify(config)],{cwd:directory,env,timeout:15_000})
    const status = await run(claude!,['mcp','get','mcp_stdio'],{cwd:directory,env,timeout:15_000})
    // Do not echo status/configuration on failure: native CLIs can include credentials in their output.
    assert.ok(status.stdout.includes('Connected'),'STDIO initialization was not confirmed')
    assert.ok((await readFile(receipt,'utf8')).includes('initialize'))
  } finally { await rm(directory,{recursive:true,force:true}) }
})

test('pinned upstream SSE bridge initializes with the task header without a model call', {skip:process.env.MIKKA_NATIVE_SSE_BRIDGE !== '1',timeout:90_000}, async () => {
  let stream: ServerResponse | undefined, authorized = false
  const server = createServer(async (request,response)=>{
    if (request.headers.authorization !== 'Bearer synthetic-task-token') { response.writeHead(401); response.end(); return }
    authorized = true
    if (request.method === 'GET') { response.writeHead(200,{'content-type':'text/event-stream'});response.write('event: endpoint\ndata: /messages\n\n');stream=response;return }
    let body = '';for await(const chunk of request) body += chunk
    const message = JSON.parse(body)
    response.writeHead(202);response.end()
    if ('id' in message) stream!.write(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'native-sse-fixture',version:'1'}}})}\n\n`)
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const port = (server.address() as {port:number}).port
  const bridge = codexMcpServer({name:'mcp_sse',transport:'sse',url:`http://127.0.0.1:${port}/sse`,headers:{Authorization:'Bearer synthetic-task-token'}})
  assert.ok(bridge.transport === 'stdio')
  const child = spawn(bridge.command,bridge.args,{env:{...process.env,...bridge.env},stdio:['pipe','pipe','pipe']})
  let output = ''
  try {
    const initialized = new Promise<void>((resolve,reject)=>{
      const deadline = setTimeout(()=>reject(new Error('SSE bridge initialization timed out')),60_000)
      child.once('error',()=>{clearTimeout(deadline);reject(new Error('SSE bridge failed to start'))})
      child.once('exit',()=>{clearTimeout(deadline);reject(new Error('SSE bridge exited before initialization'))})
      child.stdout.on('data',chunk=>{output+=chunk; if(output.includes('native-sse-fixture')){clearTimeout(deadline);resolve()}})
      child.stderr.resume()
    })
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'mikka-cli-fixture',version:'1'}}})+'\n')
    await initialized
    assert.ok(authorized)
    assert.ok(!output.includes('synthetic-task-token'))
  } finally {
    child.stdin.end(); child.kill('SIGTERM'); stream?.end(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})
