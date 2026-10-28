// Pure child smoke: the actual loader and suite, stopped before native connect.
import './credential-diagnostics-offline.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { after } from 'node:test'
import net from 'node:net'
import pg, * as esm from 'pg'
import { scopeNativeRuntime } from './scope-acceptance-runtime.mjs'
import { scopeUrl } from './scope-acceptance-policy.mjs'
import { scopeWireOutput } from './scope-exec-file.mjs'
import { promisify } from 'node:util'

const requested=process.argv[2],resumeTeam=requested==='team-resume'
const phase=resumeTeam?'team':requested
assert.ok(['scope','team'].includes(phase))
let nativeTransportAttempts = 0, nativeSqlSubmissions = 0, deniedConnections = 0, offlineMigrationReplies = 0
net.Socket.prototype.connect = () => { nativeTransportAttempts++;throw Error('offline transport prohibited') }
const nativeQuery = pg.Client.prototype.query
pg.Client.prototype.query = function () { nativeSqlSubmissions++;throw Error('offline native SQL prohibited') }
const paths = execFileSync('git', ['ls-files','-z','--','*.ts','*.tsx','*.mjs','*.js','*.json'], { encoding: 'utf8', timeout: 5000 }).split('\0').filter(Boolean)
const frozen = new Map(paths.map(file => [resolve(file), readFileSync(file)]))
const url = scopeUrl('issue184_e2e')
Object.assign(process.env, { E2E_DATABASE_URL: url, MIKKA_DATABASE_URL: url, DATABASE_URL: url })
const runtime = scopeNativeRuntime(pg, async (kind,input) => {
  if (kind === 'resume-team'&&resumeTeam)return {resumed:true,bootstrapReexecuted:false,databases:input.databases}
  if (kind === 'resume-scope') return { resumed: true, bootstrapReexecuted: false }
  if (kind === 'connect') { deniedConnections++;throw Error('OFFLINE_FIRST_CONNECTION_BOUNDARY') }
  if (kind === 'migrate' && ++offlineMigrationReplies === 1) return scopeWireOutput({ stdout: 'applied offline-contract.sql\n', stderr: 'offline diagnostic\n' })
  if (kind === 'query' || kind === 'cleanup' || kind === 'migrate') throw Error('unexpected offline SQL/migration request')
}, phase, 'suite')
runtime.install(frozen, phase === 'scope',resumeTeam)
const { execFile } = await import('node:child_process')
if(!resumeTeam){
const bridgeOutput = await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], { env: { MIKKA_DATABASE_URL: url, DATABASE_URL: url } })
assert.deepEqual(bridgeOutput, { stdout: 'applied offline-contract.sql\n', stderr: 'offline diagnostic\n' })
}
const cjs = createRequire(import.meta.url)('pg')
assert.equal(cjs, pg);assert.equal(esm.default, pg)
for (const [name, value] of Object.entries(esm)) if (name !== 'default') assert.equal(value, pg[name])
assert.equal(new pg.Pool({ connectionString: url }).Client, pg.Client)
after(async () => {
  await runtime.close();pg.Client.prototype.query = nativeQuery
  assert.ok(deniedConnections > 0);assert.equal(nativeTransportAttempts, 0);assert.equal(nativeSqlSubmissions, 0)
  if(resumeTeam)assert.equal(offlineMigrationReplies,0)
  console.log(JSON.stringify({ offlineStartup: requested, deniedConnections, nativeTransportAttempts, nativeSqlSubmissions }))
})
await import(phase === 'scope' ? '../tests/issue-scope-detachment.db.test.ts' : '../tests/team-issue-create.db.test.ts')
