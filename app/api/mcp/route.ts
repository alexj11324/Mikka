import { personalMailboxEnabled } from '@/lib/personal-mailbox-config'
import type { AuthInfo } from '@modelcontextprotocol/server'
import type { MailboxToolName } from '@mikka/protocol/mailbox'
import { mailboxAck, mailboxSend } from '@/lib/mailbox-tools'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { withBasePath } from '@/lib/base-path'
import { mcpActor, mcpUserId, verifyMcpToken } from '@/lib/mcp/auth'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'
import { MCP_SCOPE } from '@/lib/mcp/resource'
import { COMPOSIO_ACTIONS } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import * as actions from '@/lib/mcp/actions'
import * as tools from '@/lib/mcp/tools'
import * as worker from '@/lib/mcp/worker'
import * as artifacts from '@/lib/mcp/artifacts'
import { ARTIFACT_KINDS } from '@/lib/db/schema'
import { ARTIFACT_TITLE_MAX } from '@/lib/artifacts/limits'

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

/** One tool for every harness: a run's agent and an OAuth agent submit artifacts the same way. */
const SUBMIT_ARTIFACT = {
  title: 'Hand over a document or web page',
  description: 'Hand a finished document (Markdown) or web page (HTML) to the person. It shows as a card in their chat and opens in a reader where they can quote parts of it back to you. Send the whole file each time; pass artifactId to make the next version of one you sent before, so the person can compare versions. HTML runs sandboxed with no network: inline every script, style, image and font (data: URLs), and do not fetch anything. Markdown may use GitHub tables; raw HTML in Markdown is shown as text.',
  inputSchema: z.object({
    title: z.string().trim().min(1).max(ARTIFACT_TITLE_MAX),
    kind: z.enum(ARTIFACT_KINDS).describe('markdown for a document, html for a web page.'),
    content: z.string().min(1).max(2_000_000).describe('The whole file. At most 1 MB of Markdown or 2 MB of HTML.'),
    artifactId: id.optional().describe('An artifact you sent before, to add its next version.'),
  }),
}

/**
 * The Mikka MCP server: lets an agent such as Claude Code or Codex talk to the
 * person's Coordinator and read their issues and runs. Agents sign in with
 * OAuth (lib/auth.ts); every tool acts as the person who approved them, and
 * writes go through the same server actions as the UI (lib/mcp/actions.ts).
 */
const handler = createMcpHandler(server => {
  server.registerTool('send_to_coordinator', {
    title: 'Send a message to the Coordinator',
    description: 'Send a message to the person\'s Mikka Coordinator, the agent that plans work and dispatches runs, as Agent coordination data, not user input or approval. The Coordinator answers in its own time; call read_coordinator_messages with the returned `after` and waitSeconds to get the reply.',
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

  server.registerTool('submit_artifact', SUBMIT_ARTIFACT, async (input, ctx) => {
    const userId = mcpUserId(ctx.http?.authInfo)
    return outcome(await artifacts.submit(await artifacts.oauthSubmitter(userId, ctx.http?.authInfo), input))
  })

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
    title: 'List local execution tools',
    description: 'List available local execution tools and their computers. Use the returned internal id as agentId for dispatch_run and provide the repository URL separately. Never repeat hidden identity names, ids or harness keys in replies. Name the computer and its Claude Code or Codex tool when needed; call delegated work a thread, never an Agent.',
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
    inputSchema: z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(50_000).optional().describe('Plain text; one paragraph per line.'), ...issueChanges }).strict(),
  }, async (input, ctx) => outcome(await actions.createIssue(mcpUserId(ctx.http?.authInfo), input, mcpActor(ctx.http?.authInfo))))

  server.registerTool('update_issue', {
    title: 'Update an issue',
    description: 'Change an issue\'s title, status, priority, project, labels or assignee. Only the fields given change. The text is edited in the app, not here.',
    inputSchema: z.object({ issueId: id, title: z.string().trim().min(1).max(200).optional(), ...issueChanges }).strict(),
    annotations: { idempotentHint: true },
  }, async (input, ctx) => outcome(await actions.updateIssue(mcpUserId(ctx.http?.authInfo), input, mcpActor(ctx.http?.authInfo))))

  server.registerTool('link_issues', {
    title: 'Link issues',
    description: 'Add or remove a relation from one issue to another: parent, child, related, blockedBy, blocks or duplicate. `remove` takes it off; a parent link with a null target clears the parent.',
    inputSchema: z.object({
      issueId: id, kind: z.enum(['parent', 'child', 'related', 'blockedBy', 'blocks', 'duplicate']),
      targetId: id.nullable(), remove: z.boolean().optional(),
    }),
  }, async (input, ctx) => outcome(await actions.linkIssues(mcpUserId(ctx.http?.authInfo), input, mcpActor(ctx.http?.authInfo))))

  server.registerTool('dispatch_run', {
    title: 'Dispatch a run',
    description: 'Queue a thread for an issue on the selected computer. Its daemon clones the repository into its own cache and runs the selected coding harness. Returns the run id at once; follow it with get_run or list_runs.',
    inputSchema: z.object({
      issueId: id, agentId: id,
      repo: z.string().trim().min(1).max(4_000).describe('GitHub owner/repo or an HTTPS/SSH git URL. The daemon clones it; no repository registration is needed.'),
      note: z.string().max(10_000).optional().describe('Extra direction for this run, added after the issue text.'),
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
function createWorkerHandler(mailbox: readonly MailboxToolName[]) { return createMcpHandler(server => {
  for (const [name, action] of Object.entries({ mailbox_recipients: 'recipients', mailbox_send: 'send', mailbox_inbox: 'inbox', mailbox_ack: 'ack', mailbox_sent: 'sent' }).filter(([name]) => mailbox.includes(name as MailboxToolName))) {
    server.registerTool(name, {
      description: action === 'send' ? 'Queue a short personal peer message; use a stable key for exact retries and replyTo for replies. No user authority or execution is granted.' : 'Inspect or acknowledge your authenticated personal mailbox at a safe boundary. No automatic wake or terminal resume. Read is not ACK.',
      inputSchema: action === 'send' ? mailboxSend.strict() : action === 'ack' ? mailboxAck.strict() : z.object({}).strict(),
    }, async (input, ctx) => {
      const run = worker.workerRun(ctx.http?.authInfo)
      const { personalWorkerMailbox } = await import('@/lib/personal-mailbox-runtime')
      const result = await personalWorkerMailbox(run.userId, run.id, { ...input, action }, ctx.http!.authInfo!.token, ctx.mcpReq.signal)
      return { isError: result.status !== 200, content: [{ type: 'text' as const, text: JSON.stringify(result.body) }] }
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

  server.registerTool('submit_artifact', SUBMIT_ARTIFACT, async (input, ctx) => outcome(await artifacts.submit(await artifacts.runSubmitter(worker.workerRun(ctx.http?.authInfo)), input)))

  server.registerTool('blocked', {
    title: 'Say you are blocked',
    description: 'Tell the person\'s Coordinator you cannot go on, and why: missing access, a broken environment, a contradiction in the task. The Coordinator tells the person.',
    inputSchema: z.object({ reason: z.string().trim().min(1).max(4000) }),
  }, async ({ reason }, ctx) => message(await worker.blocked(worker.workerRun(ctx.http?.authInfo), reason)))
}, { serverInfo: { name: 'mikka-worker', version: '1.0.0' } }) }

const workerHandler = createWorkerHandler([])
const workerAuthed = withMcpAuth(async request => {
  // withMcpAuth supplies auth after verification. Never inspect request JSON
  // for catalogue selection or trust a client-provided definition/origin.
  const run = worker.workerRun((request as Request & { auth?: AuthInfo }).auth)
  const tools = personalMailboxEnabled() ? await (await import('@/lib/personal-mailbox-runtime')).personalWorkerMailboxAdvertised(run.userId, run.id) : []
  const handler = tools.length ? createWorkerHandler(tools) : workerHandler
  return handler(request)
}, worker.verifyRunToken, { required: true, resourceMetadataPath: withBasePath('/.well-known/oauth-protected-resource') })

function route(request: Request) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)/i)?.[1]
  return bearer?.startsWith(worker.RUN_TOKEN_PREFIX) ? workerAuthed(request) : authed(request)
}

export { route as GET, route as POST, route as DELETE }
