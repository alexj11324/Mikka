// Invoked only by the exact-manifest supervisor. No standalone target fallback.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { after } from 'node:test'
import { scopeRpcError } from './scope-exec-file.mjs'
import { lostScopeSupervisor } from './scope-acceptance-policy.mjs'
import { scopeNativeRuntime } from './scope-acceptance-runtime.mjs'
if (!process.send || !['scope','team'].includes(process.env.SCOPE_ACCEPTANCE_PHASE)) throw Error('scope worker requires supervisor IPC')
const manifest = JSON.parse(readFileSync(process.env.SCOPE_ACCEPTANCE_MANIFEST, 'utf8'))
if (createHash('sha256').update(readFileSync(process.env.SCOPE_ACCEPTANCE_MANIFEST)).digest('hex') !== process.env.SCOPE_ACCEPTANCE_MANIFEST_SHA256) throw Error('scope manifest changed')
const frozenSources=new Map()
for(const file of manifest.sources){const bytes=readFileSync(file.path);if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('scope frozen source changed');frozenSources.set(resolve(file.path),bytes)}
let sequence = 0
const pending = new Map()
const rpc = (kind, input = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;pending.set(id, { resolve, reject });process.send({ id, kind, input })
})
let runtime, completed=false
process.on('disconnect',()=>{if(!completed)void lostScopeSupervisor(async()=>{runtime?.cancel();await runtime?.close()},code=>process.exit(code))})
process.on('message', message => {
  if(message.control==='abort'){runtime?.cancel();return}
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.error) request.reject(scopeRpcError(message.error))
  else request.resolve(message.value)
})
const phase = process.env.SCOPE_ACCEPTANCE_PHASE, mode = process.env.SCOPE_ACCEPTANCE_MODE
// Import native pg before installing the scoped replacement. Import is not a
// connection; all subsequent constructors go through the target/timeouts gate.
const pg = (await import('pg')).default
runtime = scopeNativeRuntime(pg, rpc, phase, mode)
runtime.install(frozenSources,manifest.mode==='resume-scope-after-bootstrap'&&phase==='scope'&&mode==='suite')
if (mode !== 'migrate') after(async () => {
  try { await runtime.close();await rpc('finished', runtime.stats()) }
  finally { completed=true;if(process.connected)process.disconnect() }
})
try {
  if (mode === 'migrate') {
    await import('./migrate.mjs')
    await runtime.close();await rpc('finished', runtime.stats());completed=true;if(process.connected)process.disconnect()
  } else {
    const file = phase === 'scope' ? '../tests/issue-scope-detachment.db.test.ts' : '../tests/team-issue-create.db.test.ts'
    await import(file)
  }
} catch (error) { runtime.abort(error);await runtime.close();process.disconnect();throw error }
