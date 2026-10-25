import { appendAudit } from '@/lib/audit/store'
import { pool as auditPool } from '@/lib/db'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { withBasePath } from '@/lib/base-path'
import { mcpUserId, verifyMcpToken, withMcpTool } from '@/lib/mcp/auth'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'
import { MCP_SCOPE } from '@/lib/mcp/resource'
import { COMPOSIO_ACTIONS } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { dispatchRequestKey } from '@/lib/run-dispatch'
import * as actions from '@/lib/mcp/actions'
import * as tools from '@/lib/mcp/tools'
import * as worker from '@/lib/mcp/worker'
import { credentialToolDefinitions, type CredentialToolName } from '@/lib/credentials/execution-tools'
import { executeSystemCredentialTool } from '@/lib/credentials/runtime'
import type { AuthInfo } from '@modelcontextprotocol/server'

export const dynamic = 'force-dynamic'
// Leaves room for read_coordinator_messages to wait for a reply.
export const maxDuration = 120

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function message(value: string) {
  return { content: [{ type: 'text' as const, text: value }] }
}

/** A write's result: the value, or the action's error code as a tool error. */
function outcome(value: unknown) {
  return value && typeof value === 'object' && 'error' in value ? { ...json(value), isError: true } : json(value)
}

function notFound(what: string) {
  return { content: [{ type: 'text' as const, text: `${what} not found` }], isError: true }
}

const id = z.uuid()

/**
 * The Mikka MCP server: lets an agent such as Claude Code or Codex talk to the
 * person's Coordinator and read their issues and runs. Agents sign in with
 * OAuth (lib/auth.ts); every tool acts as the person who approved them, and
 * writes go through the same server actions as the UI (lib/mcp/actions.ts).
 */
const handler = createMcpHandler(server => {
  const register = server.registerTool.bind(server)
  server.registerTool = ((...args: Parameters<typeof server.registerTool>) => {
    const [name, config, callback] = args
    return register(name, config, async (input, ctx) => withMcpTool(ctx.http?.authInfo, name, async () => callback(input, ctx)))
  }) as typeof server.registerTool

  for (const [name, definition] of Object.entries(credentialToolDefinitions)) {
    server.registerTool(name, { description: definition.description, inputSchema: definition.inputSchema }, async (input: unknown, ctx: { http?: { authInfo?: AuthInfo } }) =>
      outcome(await executeSystemCredentialTool({ userId: mcpUserId(ctx.http?.authInfo) }, name as CredentialToolName, input)))
  }
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

  server.registerTool('get_run_events', {
    title: 'Read a run\'s events',
    description: 'Page through a run\'s event stream (what the agent said and did), oldest first. Pass the returned `next` as `after` for the next page; `next` is null at the end.',
    inputSchema: z.object({ runId: id, after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional().describe('Default 50.') }),
    annotations: { readOnlyHint: true },
  }, async (input, ctx) => {
    const events = await actions.getRunEvents(mcpUserId(ctx.http?.authInfo), input)
    return events ? json(events) : notFound('Run')
  })

  server.registerTool('search_issues', {
    title: 'Search issues',
    description: 'Find issues whose title or text contains the words, most recently updated first.',
    inputSchema: z.object({ query: z.string().trim().min(1).max(200), status: z.enum(ISSUE_STATUS_CODES).optional() }),
    annotations: { readOnlyHint: true },
  }, async (input, ctx) => json(await actions.searchIssues(mcpUserId(ctx.http?.authInfo), input)))

  server.registerTool('list_projects', {
    title: 'List projects',
    description: 'List the person\'s projects with their status, dates and issue ids.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async (_input, ctx) => json(await actions.listProjects(mcpUserId(ctx.http?.authInfo))))

  server.registerTool('list_labels', {
    title: 'List labels',
    description: 'List the labels on the person\'s issues, most used first.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async (_input, ctx) => json(await actions.listLabels(mcpUserId(ctx.http?.authInfo))))

  server.registerTool('search_notion_pages', {
    title: COMPOSIO_ACTIONS.search_notion_pages.title,
    description: COMPOSIO_ACTIONS.search_notion_pages.description,
    inputSchema: COMPOSIO_ACTIONS.search_notion_pages.inputSchema,
    annotations: { readOnlyHint: true },
  }, async (input, ctx) => outcome(await runComposioAction(mcpUserId(ctx.http?.authInfo), 'search_notion_pages', input)))

  server.registerTool('read_notion_page_blocks', {
    title: COMPOSIO_ACTIONS.read_notion_page_blocks.title,
    description: COMPOSIO_ACTIONS.read_notion_page_blocks.description,
    inputSchema: COMPOSIO_ACTIONS.read_notion_page_blocks.inputSchema,
    annotations: { readOnlyHint: true },
  }, async (input, ctx) => outcome(await runComposioAction(mcpUserId(ctx.http?.authInfo), 'read_notion_page_blocks', input)))

  server.registerTool('search_slack_messages', {
    title: COMPOSIO_ACTIONS.search_slack_messages.title,
    description: COMPOSIO_ACTIONS.search_slack_messages.description,
    inputSchema: COMPOSIO_ACTIONS.search_slack_messages.inputSchema,
    annotations: { readOnlyHint: true },
  }, async (input, ctx) => outcome(await runComposioAction(mcpUserId(ctx.http?.authInfo), 'search_slack_messages', input)))

  server.registerTool('read_slack_thread', {
    title: COMPOSIO_ACTIONS.read_slack_thread.title,
    description: COMPOSIO_ACTIONS.read_slack_thread.description,
    inputSchema: COMPOSIO_ACTIONS.read_slack_thread.inputSchema,
    annotations: { readOnlyHint: true },
  }, async (input, ctx) => outcome(await runComposioAction(mcpUserId(ctx.http?.authInfo), 'read_slack_thread', input)))

  server.registerTool('list_agents', {
    title: 'List agents',
    description: 'List the person\'s agents with their harness, whether their device is online, and the repositories on that device. dispatch_run needs an agent id and one of its repository ids.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async (_input, ctx) => json(await actions.listAgents(mcpUserId(ctx.http?.authInfo))))

  const issueChanges = {
    status: z.enum(ISSUE_STATUS_CODES).optional(),
    priority: z.enum(ISSUE_PRIORITY_CODES).optional(),
    projectId: id.nullable().optional().describe('A project id from list_projects; null takes the issue out of its project.'),
    labels: z.array(z.string().trim().min(1).max(40)).max(12).optional().describe('The full set of label names; a known name keeps its color.'),
    assigneeAgentId: id.nullable().optional().describe('An agent id from list_agents; null unassigns.'),
  }

  server.registerTool('create_issue', {
    title: 'Create an issue',
    description: 'Create an issue for the person. Status defaults to todo and priority to normal.',
    inputSchema: z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(50_000).optional().describe('Plain text; one paragraph per line.'), ...issueChanges }),
  }, async (input, ctx) => outcome(await actions.createIssue(mcpUserId(ctx.http?.authInfo), input)))

  server.registerTool('update_issue', {
    title: 'Update an issue',
    description: 'Change an issue\'s title, status, priority, project, labels or assigned agent. Only the fields given change. The text is edited in the app, not here.',
    inputSchema: z.object({ issueId: id, title: z.string().trim().min(1).max(200).optional(), ...issueChanges }),
    annotations: { idempotentHint: true },
  }, async (input, ctx) => outcome(await actions.updateIssue(mcpUserId(ctx.http?.authInfo), input)))

  server.registerTool('link_issues', {
    title: 'Link issues',
    description: 'Add or remove a relation from one issue to another: parent, child, related, blockedBy, blocks or duplicate. `remove` takes it off; a parent link with a null target clears the parent.',
    inputSchema: z.object({
      issueId: id, kind: z.enum(['parent', 'child', 'related', 'blockedBy', 'blocks', 'duplicate']),
      targetId: id.nullable(), remove: z.boolean().optional(),
    }),
  }, async (input, ctx) => outcome(await actions.linkIssues(mcpUserId(ctx.http?.authInfo), input)))

  server.registerTool('dispatch_run', {
    title: 'Dispatch a run',
    description: 'Queue a run: one agent works one issue in one repository on its device. Returns the run id at once; follow it with get_run or list_runs.',
    inputSchema: z.object({
      issueId: id, agentId: id,
      deviceRepoId: id.describe('A repository id from list_agents, on the agent\'s own device.'),
      note: z.string().max(10_000).optional().describe('Extra direction for this run, added after the issue text.'),
      requestKey: dispatchRequestKey.optional().describe('Reuse this key when retrying the same dispatch. Changed parameters with the same key are rejected.'),
    }),
  }, async (input, ctx) => outcome(await actions.dispatchRun(mcpUserId(ctx.http?.authInfo), input)))

  server.registerTool('send_to_run', {
    title: 'Message a running agent',
    description: 'Send a message to the agent of a running run. It reads it on its next poll.',
    inputSchema: z.object({ runId: id, text: z.string().trim().min(1).max(10_000) }),
  }, async (input, ctx) => outcome(await actions.sendToRun(mcpUserId(ctx.http?.authInfo), input)))

  server.registerTool('stop_run', {
    title: 'Stop a run',
    description: 'Ask a run to stop. The agent stops on its next poll and the run ends as stopped.',
    inputSchema: z.object({ runId: id }),
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ runId }, ctx) => outcome(await actions.stopRun(mcpUserId(ctx.http?.authInfo), runId)))

  server.registerTool('read_coordinator_memory', {
    title: 'Read the Coordinator\'s memory',
    description: 'Read the notes the Coordinator keeps about the person across conversations.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async (_input, ctx) => json(await actions.readMemory(mcpUserId(ctx.http?.authInfo))))

  server.registerTool('remember', {
    title: 'Add to the Coordinator\'s memory',
    description: 'Save one short note to the Coordinator\'s memory: a lasting preference or decision, not status that will soon change.',
    inputSchema: z.object({ note: z.string().trim().min(1).max(500) }),
  }, async ({ note }, ctx) => outcome(await actions.remember(mcpUserId(ctx.http?.authInfo), note)))

  server.registerTool('forget', {
    title: 'Remove from the Coordinator\'s memory',
    description: 'Remove every line of the Coordinator\'s memory that contains this text.',
    inputSchema: z.object({ text: z.string().trim().min(1).max(200) }),
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ text }, ctx) => outcome(await actions.forget(mcpUserId(ctx.http?.authInfo), text)))
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
  server.registerTool('resume_account_actions', {
    title: 'Read bound account actions',
    description: 'Recover the persisted operation references and status assigned to this live run. Read-only: cannot approve or send. Omit operationId to list bound actions.',
    inputSchema: z.object({ operationId: z.uuid().optional() }),
  }, async ({ operationId }, ctx) => message(JSON.stringify(await worker.resumeAccountActions(ctx.http?.authInfo, operationId))))

  for (const [name, definition] of Object.entries(credentialToolDefinitions)) {
    server.registerTool(name, { description: definition.description, inputSchema: definition.inputSchema }, async (input: unknown, ctx: { http?: { authInfo?: AuthInfo } }) => {
      const run = await worker.authorizeToolRun(ctx.http?.authInfo)
      return outcome(await executeSystemCredentialTool({ userId: run.userId, runId: run.id, taskId: run.issueId }, name as CredentialToolName, input))
    })
  }
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

async function route(request: Request) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)/i)?.[1]
  const response = await (bearer?.startsWith(worker.RUN_TOKEN_PREFIX) ? workerAuthed(request) : authed(request))
  if (response && response.status >= 400) {
    try { await appendAudit(auditPool, 'system:auth', { actorId: 'anonymous', actorType: 'anonymous', resourceId: 'mcp', action: 'authorization.denied', outcome: 'denied', reason: `mcp_http_${response.status}` }) }
    catch { return Response.json({ error: 'auditUnavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
  }
  return response
}

export { route as GET, route as POST, route as DELETE }
