import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { owner, home, ownerReads, revisionReads } from './actual-module-boundary.mjs'

const boundary = new URL('./actual-module-boundary.mjs', import.meta.url).href
const replacements = new Map([
  [new URL('./checkout/lib/workspace-db.ts', import.meta.url).href, `export { workspacePool } from ${JSON.stringify(boundary)}`],
  [new URL('./checkout/lib/db/request-scope.ts', import.meta.url).href, `export { pool } from ${JSON.stringify(boundary)}`],
])
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context)
    const source = replacements.get(resolved.url)
    return source ? { url: `revision-boundary:${encodeURIComponent(source)}`, shortCircuit: true } : resolved
  },
  load(url, context, next) {
    return url.startsWith('revision-boundary:') ? { format: 'module', source: decodeURIComponent(url.slice('revision-boundary:'.length)), shortCircuit: true } : next(url, context)
  },
})

const [{ createReadBatch }, { beginOwnerListRead }] = await Promise.all([
  import('./checkout/lib/desktop-rpc/read-batch.ts'),
  import('./checkout/lib/live/revision-read.ts'),
])
let ready
const firstData = new Promise(resolve => { ready = resolve })
const schema = { safeParse: args => Array.isArray(args) && args.length === 0 ? { success: true, data: args } : { success: false } }
const actions = {
  'task-runs.pollTaskRuns': { args: schema, invoke: async () => {
    const begun = await beginOwnerListRead(owner, ['task_run_list'])
    ready()
    return { items: [], live: begun }
  } },
  'issues.syncIssueList': { args: schema, invoke: async () => {
    // The real issue reader has asynchronous workspace work before this call.
    // This barrier chooses a legal completion order; it is not product code.
    await firstData
    const begun = await beginOwnerListRead(owner, ['issue_list'], [{ kind: 'issue_list', id: home }])
    return { items: [], version: 'fixture-version', live: begun }
  } },
}
const result = await createReadBatch(() => actions)(Object.keys(actions).map(action => ({ action, args: [] })))
console.log(JSON.stringify({ actualModules: ['createReadBatch', 'beginOwnerListRead', 'readRevisions', 'ownerLiveReadScope', 'readBatchOwnerScope', 'readBatchRevisions', 'readLiveRevisions'], ownerReads, revisionReads, result, realPostgres: false, actualModelCalls: 0 }))
assert.ok(result.every(item => item.ok))
assert.equal(ownerReads.length, 1)
assert.deepEqual(result[0].result.live.revisions, { [`task_run_list:${home}`]: 7 })
assert.deepEqual(result[1].result.live.revisions, { [`issue_list:${home}`]: 7 })
assert.equal(revisionReads.length, 1, 'one already prepared owner batch needs one revision SELECT across staggered readers')
