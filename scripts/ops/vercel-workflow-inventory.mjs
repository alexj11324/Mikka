import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { PROJECT, TEAM } from './deployment-regression.mjs'

// A scan includes all Mikka workflows, even historical names we do not recognize.
// A fingerprint lets operators reconcile reports without publishing an Eve session ID.
export async function inventoryWorkflowRuns(listRuns) {
  const startedAt = new Date().toISOString()
  const runs = new Map()
  let pages = 0
  for (const status of ['pending', 'running']) {
    let cursor
    const seen = new Set()
    do {
      const result = await listRuns(status, { limit: 100, sortOrder: 'asc', ...(cursor && { cursor }) })
      pages++
      if (!Array.isArray(result?.data) || result.data.length > 100 || typeof result.hasMore !== 'boolean') {
        throw new Error('workflow_inventory_page_invalid')
      }
      for (const item of result.data) {
        if (item?.status !== status || !/^wrun_[a-zA-Z0-9_-]{10,160}$/.test(item.runId ?? '')
            || !/^dpl_[a-zA-Z0-9]+$/.test(item.deploymentId ?? '') || typeof item.workflowName !== 'string') {
          throw new Error('workflow_inventory_run_invalid')
        }
        // A run can become running between the two queries. Record it once, in its latest observed state.
        const fingerprint = createHash('sha256').update(item.runId).digest('hex')
        const owner = /^workflow\/\/eve(?:@[^/]+)?\/\//.test(item.workflowName) ? 'eve' :
          item.workflowName.startsWith('workflow//./workflows/') ? 'mikka' : 'unclassified'
        runs.set(fingerprint, { fingerprint, deploymentId: item.deploymentId, owner, status })
      }
      if (!result.hasMore) break
      if (!result.data.length || typeof result.cursor !== 'string' || !result.cursor || seen.has(result.cursor)) {
        throw new Error('workflow_inventory_cursor_invalid')
      }
      cursor = result.cursor
      seen.add(cursor)
    } while (cursor)
  }
  return { projectId: PROJECT, teamId: TEAM, environment: 'production', startedAt, finishedAt: new Date().toISOString(),
    pages, activeRuns: [...runs.values()] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { managedReader } = await import('../acceptance/workflow-migration-production.mjs')
    const reader = await managedReader(process.env.VERCEL_TEAM_TOKEN)
    console.log(JSON.stringify(await inventoryWorkflowRuns(reader.listRuns), null, 2))
  } catch (error) {
    const status = error?.status
    const code = ['workflow_inventory_page_invalid', 'workflow_inventory_run_invalid', 'workflow_inventory_cursor_invalid',
      'manager_token_required', 'manager_read_unavailable'].includes(error?.message) ? error.message : 'workflow_inventory_read_failed'
    console.error(JSON.stringify({ code, ...(Number.isInteger(status) && { httpStatus: status }) }))
    process.exitCode = 1
  }
}
