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
// Loads the whole real dependency tree (typescript, pg, the team session fixture) with both
// compile caches disabled, so its cost is dominated by cold module loading rather than by
// anything the assertions measure. CI samples of the same commit: 8752ms and 15187ms — the
// old 15000ms cap sat inside that spread and SIGTERM'd healthy runs. The cap is a liveness
// guard against a hung child, not a performance budget, so it is set well clear of the spread.
test('all real team dependencies and auth export/session metadata load before the denied native SQL boundary',{timeout:120000},async t=>{
  const result=await promisify(execFile)(process.execPath,['--import','./scripts/credential-diagnostics-offline.mjs','--import','./scripts/server-test.mjs','--import','tsx','scripts/team-import-contract.mjs'],{
    timeout:90000,maxBuffer:1<<20,env:{PATH:process.env.PATH,HOME:'/workspace',NODE_DISABLE_COMPILE_CACHE:'1',TSX_DISABLE_CACHE:'1',NODE_ENV:'development',MIGRATE:'0',VERCEL_ENV:'',BETTER_AUTH_URL:'http://127.0.0.1:3100',NEXT_TELEMETRY_DISABLED:'1'},
  })
  const report=result.stdout.split('\n').find(line=>line.startsWith('{"teamImportContract":true'))
  assert.ok(report);t.diagnostic(report)
  assert.match(result.stdout,/"teamImportContract":true/)
  assert.match(result.stdout,/"scenarios":24/)
  assert.match(result.stdout,/"nativeTransportAttempts":0,"nativeSqlSubmissions":0/)
  assert.doesNotMatch(result.stdout+result.stderr,/does not provide an export|reading 'builtins'/)
})
