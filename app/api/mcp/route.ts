import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { withBasePath } from '@/lib/base-path'
import { mcpUserId, verifyMcpToken } from '@/lib/mcp/auth'
import { MCP_SCOPE } from '@/lib/mcp/resource'
import * as tools from '@/lib/mcp/tools'
import * as worker from '@/lib/mcp/worker'

export const dynamic = 'force-dynamic'
// Leaves room for read_coordinator_messages to wait for a reply.
export const maxDuration = 120

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function message(value: string) {
  return { content: [{ type: 'text' as const, text: value }] }
}

function notFound(what: string) {
  return { content: [{ type: 'text' as const, text: `${what} not found` }], isError: true }
}

const id = z.uuid()

/**
 * The Mikka MCP server: lets an agent such as Claude Code or Codex talk to the
 * person's Coordinator and read their issues and runs. Agents sign in with
 * OAuth (lib/auth.ts); every tool acts as the person who approved them.
 */
const handler = createMcpHandler(server => {
  server.registerTool('send_to_coordinator', {
    title: 'Send a message to the Coordinator',
    description: 'Send a message to the person\'s Mikka Coordinator, the agent that plans work and dispatches runs, as if the person typed it in the chat. The Coordinator answers in its own time; call read_coordinator_messages with the returned `after` and waitSeconds to get the reply.',
    inputSchema: z.object({ text: z.string().trim().min(1).max(10_000) }),
  }, async ({ text }, ctx) => json(await tools.sendToCoordinator(mcpUserId(ctx.http?.authInfo), text)))

  server.registerTool('read_coordinator_messages', {
    title: 'Read the Coordinator conversation',
    description: 'Read the conversation with the Coordinator, oldest first: the person\'s messages and the Coordinator\'s replies (with the names of tools it called). Pass `after` to get only newer messages, and waitSeconds to wait for the Coordinator to reply. `last` is the position to pass as `after` next time; `working` says a turn is running and `lastError` why the last one failed.',
    inputSchema: z.object({
      after: z.number().int().min(0).optional().describe('Only messages after this position.'),
      limit: z.number().int().min(1).max(100).optional().describe('At most this many of the newest messages. Default 20.'),
      waitSeconds: z.number().int().min(0).max(90).optional().describe('Wait up to this long for a Coordinator reply after `after`.'),
    }),
  }, async (input, ctx) => json(await tools.readCoordinatorMessages(mcpUserId(ctx.http?.authInfo), input)))

  server.registerTool('list_issues', {
    title: 'List issues',
    description: 'List the person\'s Mikka issues, most recently updated first. Optionally only one status (todo, doing, review, done and so on).',
    inputSchema: z.object({ status: z.string().optional() }),
    annotations: { readOnlyHint: true },
  }, async (input, ctx) => json(await tools.listIssues(mcpUserId(ctx.http?.authInfo), input)))

  server.registerTool('get_issue', {
    title: 'Read an issue',
    description: 'Read one issue: its text, status, priority and latest runs.',
    inputSchema: z.object({ issueId: id }),
    annotations: { readOnlyHint: true },
  }, async ({ issueId }, ctx) => {
    const issue = await tools.getIssue(mcpUserId(ctx.http?.authInfo), issueId)
    return issue ? json(issue) : notFound('Issue')
  })

  server.registerTool('list_runs', {
    title: 'List runs',
    description: 'List recent agent runs, newest first, optionally for one issue or only those still going.',
    inputSchema: z.object({ issueId: id.optional(), activeOnly: z.boolean().optional() }),
    annotations: { readOnlyHint: true },
  }, async (input, ctx) => json(await tools.listRuns(mcpUserId(ctx.http?.authInfo), input)))

  server.registerTool('get_run', {
    title: 'Read a run',
    description: 'Read one run: status, how it ended, the agent\'s summary, and its latest events.',
    inputSchema: z.object({ runId: id }),
    annotations: { readOnlyHint: true },
  }, async ({ runId }, ctx) => {
    const run = await tools.getRun(mcpUserId(ctx.http?.authInfo), runId)
    return run ? json(run) : notFound('Run')
  })
}, { serverInfo: { name: 'mikka', version: '1.0.0' } })

const authed = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  requiredScopes: [MCP_SCOPE],
  // The metadata sits under the app's base path; clients follow the URL in the 401.
  resourceMetadataPath: withBasePath('/.well-known/oauth-protected-resource'),
})

/**
 * The worker tools, for the agent inside a run. The daemon mounts this same
 * URL into each run with the run token from the claim; the token's prefix
 * picks these tools instead of the person's.
 */
const workerHandler = createMcpHandler(server => {
  server.registerTool('report', {
    title: 'Report progress',
    description: 'Tell the person\'s Coordinator about progress on this run. Use it sparingly, at milestones (a plan settled, a hard part solved, ready for review), not after every step.',
    inputSchema: z.object({ text: z.string().trim().min(1).max(4000) }),
  }, async ({ text }, ctx) => message(await worker.report(worker.workerRun(ctx.http?.authInfo), text)))

  server.registerTool('ask', {
    title: 'Ask the person',
    description: 'Ask the person a question through their Coordinator when you need a decision you should not make alone. Returns right away and does not wait: keep working on what you can, and the answer will arrive later as a follow-up instruction.',
    inputSchema: z.object({
      question: z.string().trim().min(1).max(2000),
      options: z.array(z.string().trim().min(1).max(200)).min(2).max(4).optional().describe('Two to four answers to pick from.'),
      context: z.string().trim().max(4000).optional().describe('What the person needs to know to answer.'),
    }),
  }, async (input, ctx) => message(await worker.ask(worker.workerRun(ctx.http?.authInfo), input)))

  server.registerTool('blocked', {
    title: 'Say you are blocked',
    description: 'Tell the person\'s Coordinator you cannot go on, and why: missing access, a broken environment, a contradiction in the task. The Coordinator tells the person.',
    inputSchema: z.object({ reason: z.string().trim().min(1).max(4000) }),
  }, async ({ reason }, ctx) => message(await worker.blocked(worker.workerRun(ctx.http?.authInfo), reason)))
}, { serverInfo: { name: 'mikka-worker', version: '1.0.0' } })

const workerAuthed = withMcpAuth(workerHandler, worker.verifyRunToken, { required: true, resourceMetadataPath: withBasePath('/.well-known/oauth-protected-resource') })

function route(request: Request) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)/i)?.[1]
  return bearer?.startsWith(worker.RUN_TOKEN_PREFIX) ? workerAuthed(request) : authed(request)
}

export { route as GET, route as POST, route as DELETE }
