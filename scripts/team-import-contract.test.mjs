import './credential-diagnostics-offline.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {teamImportInventory} from './team-import-contract.mjs'

test('team import inventory retains late imports and aliases rather than sampling only startup',()=>{
  assert.throws(()=>teamImportInventory('import(variableTarget)'),/literal module targets/)
  assert.deepEqual(teamImportInventory("const {authBaseURL:url}=await import('../lib/auth'); async function later(){const {createIssue}=await import('../lib/mcp/actions')}"),[
    {specifier:'../lib/auth',exports:['authBaseURL']},{specifier:'../lib/mcp/actions',exports:['createIssue']},
  ])
})
test('all real team dependencies and auth export/session metadata load before the denied native SQL boundary',{timeout:20000},async t=>{
  const result=await promisify(execFile)(process.execPath,['--import','./scripts/credential-diagnostics-offline.mjs','--import','./scripts/server-test.mjs','--import','tsx','scripts/team-import-contract.mjs'],{
    timeout:15000,maxBuffer:1<<20,env:{PATH:process.env.PATH,HOME:'/workspace',NODE_DISABLE_COMPILE_CACHE:'1',TSX_DISABLE_CACHE:'1',NODE_ENV:'development',MIGRATE:'0',VERCEL_ENV:'',BETTER_AUTH_URL:'http://127.0.0.1:3100',NEXT_TELEMETRY_DISABLED:'1'},
  })
  const report=result.stdout.split('\n').find(line=>line.startsWith('{"teamImportContract":true'))
  assert.ok(report);t.diagnostic(report)
  assert.match(result.stdout,/"teamImportContract":true/)
  assert.match(result.stdout,/"scenarios":22/)
  assert.match(result.stdout,/"nativeTransportAttempts":0,"nativeSqlSubmissions":0/)
  assert.doesNotMatch(result.stdout+result.stderr,/does not provide an export|reading 'builtins'/)
})
