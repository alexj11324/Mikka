import { createServer } from 'node:http'
import type { LinearIssueSnapshot } from '../../lib/linear-sync/client'

type Variables = { id?: string; input?: Record<string, unknown> }
type RequestRecord = { operation: string; variables: Variables }
type Hold = { operation: string; phase: 'before' | 'after'; fail: boolean; arrived: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> }

/** A synthetic provider boundary, never a claim of real Linear acceptance.
 * Production GraphQL/client/token code still runs; its fetch is redirected to
 * this actual HTTP loopback server before any external network can be opened. */
export async function linearLoopback(team: { id: string; key: string; name: string }) {
  const issues = new Map<string, LinearIssueSnapshot>()
  const archived = new Map<string, string>()
  const comments = new Map<string, { id: string; body: string; issue: { id: string }; parent: null; createdAt: string; user: { name: string } }>()
  const requests: RequestRecord[] = []
  const holds: Hold[] = []
  const allHolds: Hold[] = []
  const failures: string[] = []
  const server = createServer(async (incoming, outgoing) => {
    try {
      const parts: Buffer[] = []
      for await (const part of incoming) parts.push(Buffer.from(part))
      const body = JSON.parse(Buffer.concat(parts).toString()) as { query: string; variables: Variables }
      const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? 'unknown'
      requests.push({ operation, variables: body.variables })
      const index = holds.findIndex(hold => hold.operation === operation)
      const hold = index < 0 ? undefined : holds.splice(index, 1)[0]
      if (hold) { hold.arrived.resolve(); if (hold.phase === 'before') await hold.release.promise }
      const failIndex = failures.indexOf(operation)
      if (failIndex >= 0) failures.splice(failIndex, 1)
      if (failIndex >= 0) { outgoing.writeHead(503, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ errors: [{ message: 'Synthetic transport failure' }] })); return }
      const variables = body.variables
      let data: unknown
      if (operation === 'MikkaLinearArchiveState') {
        const issue = issues.get(variables.id!)
        data = { issue: issue ? { id: issue.id, team: issue.team, archivedAt: archived.get(issue.id) ?? null } : null }
      } else if (operation === 'MikkaLinearArchiveIssue') {
        if (!issues.has(variables.id!)) throw new Error('Unknown synthetic issue')
        archived.set(variables.id!, new Date().toISOString())
        data = { issueArchive: { success: true } }
      } else if (operation === 'MikkaLinearTeams') data = { teams: { nodes: [{ ...team, states: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } } }
      else if (operation === 'MikkaLinearIssue') {
        const issue = issues.get(variables.id!)
        data = { issue: issue ? { ...issue, labels: { nodes: issue.labels } } : null }
      } else if (operation === 'MikkaLinearCreateIssue') {
        const input = variables.input!
        const id = String(input.id)
        if (issues.has(id)) { outgoing.writeHead(400, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ errors: [{ message: 'Synthetic duplicate identity' }] })); return }
        const issue: LinearIssueSnapshot = { id, identifier: `MIK-${issues.size + 1000}`, title: String(input.title), description: String(input.description), dueDate: null,
          priority: Number(input.priority), url: `https://example.invalid/${id}`, updatedAt: new Date().toISOString(), state: null, team, assignee: null, labels: [] }
        issues.set(id, issue); data = { issueCreate: { success: true, issue } }
      } else if (operation === 'MikkaLinearUpdateIssue') {
        const issue = issues.get(variables.id!)
        if (!issue) throw new Error('Unknown synthetic issue')
        Object.assign(issue, variables.input, { updatedAt: new Date().toISOString() })
        data = { issueUpdate: { success: true, issue } }
      } else if (operation === 'MikkaLinearComment') data = { comment: comments.get(variables.id!) ?? null }
      else if (operation === 'MikkaLinearCreateComment') {
        const input = variables.input!
        const comment = { id: String(input.id), body: String(input.body), issue: { id: String(input.issueId) }, parent: null, createdAt: new Date().toISOString(), user: { name: 'Synthetic' } }
        comments.set(comment.id, comment); data = { commentCreate: { success: true, comment } }
      } else if (operation === 'MikkaLinearUpdateComment') {
        const comment = comments.get(variables.id!); if (!comment) throw new Error('Unknown synthetic comment')
        comment.body = String(variables.input!.body); data = { commentUpdate: { success: true } }
      } else throw new Error(`Unsupported synthetic operation ${operation}`)
      if (hold?.phase === 'after') await hold.release.promise
      outgoing.writeHead(hold?.fail ? 503 : 200, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify(hold?.fail ? { errors: [{ message: 'Synthetic lost response' }] } : { data }))
    } catch { outgoing.writeHead(500); outgoing.end(JSON.stringify({ errors: [{ message: 'Synthetic handler failure' }] })) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, issues, comments, requests,
    hold(operation: string, phase: 'before' | 'after' = 'before', fail = false) {
      const hold: Hold = { operation, phase, fail, arrived: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
      holds.push(hold); allHolds.push(hold)
      return { arrived: hold.arrived.promise, release: () => hold.release.resolve() }
    },
    failNext(operation: string) { failures.push(operation) },
    async close() {
      for (const hold of allHolds) hold.release.resolve()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
