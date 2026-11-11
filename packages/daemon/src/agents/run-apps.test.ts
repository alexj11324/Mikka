import { expect, it } from 'vitest'
import { runApps, runAppsHost, nativeMcpProcess, hasRunAppServers, registeredRunAppServer, codexMcpServer } from './run-apps'
import { claudeAppServers } from '../adapters/claude'
import { codexAppArgs } from '../adapters/codex'
import { cursorAppServers } from '../adapters/cursor'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunJournal } from '../runs/journal'
import type { RunAssignment } from '@mikka/protocol'

const token = `mkw_${'a'.repeat(43)}`
const mcp = { url: 'https://mikka.example/mikka/api/mcp', token, apps: ['gmail', 'notion', 'gmail'] }

it('derives one Mikka entry per app from the claimed run token, never a Composio URL', () => {
  const apps = runApps(mcp)
  expect(apps).toEqual({ token, apps: [
    { name: 'gmail', url: 'https://mikka.example/mikka/api/runs/mcp/gmail' },
    { name: 'notion', url: 'https://mikka.example/mikka/api/runs/mcp/notion' },
  ] })
  expect(runAppsHost(apps)).toBe('mikka.example')
})

it('registers nothing for an untrusted endpoint, token or app name', () => {
  expect(runApps(undefined)).toBeUndefined()
  expect(runApps({ ...mcp, apps: [] })).toBeUndefined()
  expect(runApps({ ...mcp, url: 'http://mikka.example/api/mcp' })).toBeUndefined()
  expect(runApps({ ...mcp, url: 'https://mikka.example/api/other' })).toBeUndefined()
  expect(runApps({ ...mcp, url: 'https://user:pw@mikka.example/api/mcp' })).toBeUndefined()
  expect(runApps({ ...mcp, token: 'oauth' })).toBeUndefined()
  expect(runApps({ ...mcp, apps: ['mikka', 'mikka_computer', 'Gmail'] })).toBeUndefined()
  expect(runApps({ ...mcp, url: 'http://127.0.0.1:3000/mikka/api/mcp', apps: ['figma'] })?.apps).toEqual([{ name: 'figma', url: 'http://127.0.0.1:3000/mikka/api/runs/mcp/figma' }])
})

it('injects Claude HTTP entries with the run bearer', () => {
  expect(claudeAppServers(runApps(mcp))).toEqual({
    gmail: { type: 'http', url: 'https://mikka.example/mikka/api/runs/mcp/gmail', headers: { Authorization: `Bearer ${token}` } },
    notion: { type: 'http', url: 'https://mikka.example/mikka/api/runs/mcp/notion', headers: { Authorization: `Bearer ${token}` } },
  })
  expect(claudeAppServers(undefined)).toEqual({})
})

it('injects Codex url and http_headers overrides next to the mikka entry', () => {
  expect(codexAppArgs(runApps({ ...mcp, apps: ['gmail'] }))).toEqual([
    '-c', 'mcp_servers.gmail.url="https://mikka.example/mikka/api/runs/mcp/gmail"',
    '-c', `mcp_servers.gmail.http_headers={ Authorization = "Bearer ${token}" }`,
  ])
  expect(codexAppArgs(undefined)).toEqual([])
})

it('injects authorized user MCP endpoints and STDIO processes directly, without the custom relay', () => {
  const configured = { ...mcp, apps: ['gmail'], servers: [
    { name: 'mcp_docs', transport: 'http' as const, url: 'https://docs.example/mcp', headers: { 'X-Api-Key': 'task-only-example' } },
    { name: 'mcp_local', transport: 'stdio' as const, command: 'node', args: ['server.js'], env: { SERVICE_TOKEN: 'task-only-example' } },
  ] }
  const native = runApps(configured)
  expect(claudeAppServers(native)).toMatchObject({
    mcp_docs: { type: 'http', url: 'https://docs.example/mcp', headers: { 'X-Api-Key': 'task-only-example' } },
    mcp_local: { type: 'stdio', command: 'node', args: ['server.js'], env: { SERVICE_TOKEN: 'task-only-example' } },
  })
  expect(codexAppArgs(native)).toContain('mcp_servers.mcp_local.command="node"')
  expect(cursorAppServers(native)).toMatchObject([
    {type:'http',name:'gmail'},
    {type:'http',name:'mcp_docs',url:'https://docs.example/mcp'},
    {name:'mcp_local',command:'node',env:[{name:'SERVICE_TOKEN',value:'task-only-example'}]},
  ])
  expect(JSON.stringify(native)).not.toContain('custom_mcp')
})

it('launches a real STDIO process in its configured directory and sends input without a shell', async () => {
  const cwd = mkdtempSync(join(tmpdir(),'mikka-mcp-launch-'))
  try {
    const launch = nativeMcpProcess({name:'mcp_local',transport:'stdio',command:process.execPath,args:['-e', `process.stdin.once('data',d=>process.stdout.write(JSON.stringify({cwd:process.cwd(),token:process.env.SERVICE_TOKEN,input:String(d)})))`],cwd,env:{SERVICE_TOKEN:'fixture-task-token'}})
    const child = spawn(launch.command,launch.args,{env:{...process.env,...launch.env},stdio:['pipe','pipe','pipe']})
    const output: Buffer[] = []
    child.stdout.on('data',data=>output.push(data))
    const exited = new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
    child.stdin.end('literal $(touch bad); input')
    expect(await exited).toBe(0)
    expect(JSON.parse(Buffer.concat(output).toString())).toEqual({cwd,token:'fixture-task-token',input:'literal $(touch bad); input'})
  } finally { rmSync(cwd,{recursive:true,force:true}) }
})

it('keeps native connection credentials in memory and strips them from restart journals', () => {
  const directory = mkdtempSync(join(tmpdir(),'mikka-mcp-journal-')), file = join(directory,'journal.json')
  try {
    const servers = [{name:'mcp_docs',transport:'http' as const,url:'https://docs.example/mcp',headers:{Authorization:'fixture-task-token'}}]
    const assignment = {runId:'mcp-task',issueId:'i',deviceId:'d',repoId:'r',harness:'mock',prompt:'work',mcp:{...mcp,servers}} as RunAssignment
    const journal = new RunJournal(file)
    journal.put({assignment,state:'running',sessionId:null,worktree:null,lastSeq:0,error:null,updatedAt:new Date().toISOString()})
    expect(journal.get('mcp-task')?.assignment.mcp?.servers).toEqual(servers)
    expect(readFileSync(file,'utf8')).not.toContain('fixture-task-token')
    const restored = new RunJournal(file).get('mcp-task')!
    expect(restored.assignment.mcp?.servers).toBeUndefined()
    expect(restored.taskSecretsWithheld).toBe(true)
  } finally { rmSync(directory,{recursive:true,force:true}) }
})

it('native MCP-only tasks require a configured process and recognize only their assigned server names', () => {
  const apps = runApps({...mcp,apps:[],servers:[{name:'mcp_local',transport:'stdio',command:'node',args:[],env:{}}]})
  expect(hasRunAppServers(apps)).toBe(true)
  expect(registeredRunAppServer(apps,'mcp_local')).toBe(true)
  expect(registeredRunAppServer(apps,'mcp_other')).toBe(false)
  expect(hasRunAppServers(undefined)).toBe(false)
})

it('Codex connects legacy SSE through a pinned native bridge with headers kept out of argv', () => {
  const server = {name:'mcp_old',transport:'sse' as const,url:'https://mcp.acme.dev/sse',headers:{Authorization:'Bearer synthetic-secret'}}
  const bridge = codexMcpServer(server)
  expect(bridge).toEqual({name:'mcp_old',transport:'stdio',command:'npx',args:['--yes','mcp-remote@0.16.5','https://mcp.acme.dev/sse','--transport','sse-only','--header','Authorization:${MIKKA_NATIVE_MCP_HEADER_0}'],env:{MIKKA_NATIVE_MCP_HEADER_0:'Bearer synthetic-secret'}})
  if (bridge.transport === 'stdio') expect(JSON.stringify(bridge.args)).not.toContain('synthetic-secret')
  expect(codexAppArgs({token,apps:[],servers:[server]})).toContain('mcp_servers.mcp_old.command="npx"')
})
