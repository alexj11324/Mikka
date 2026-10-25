import { WorkflowAgent } from '@ai-sdk/workflow'
import { isStepCount, tool } from 'ai'
import { getWorkflowMetadata } from 'workflow'
import { z } from 'zod'
import { COORDINATOR_MAX_STEPS, COORDINATOR_MODEL, coordinatorStep, turnWarning } from '@/lib/coordinator/model'
import { createComposioAITools } from '@/lib/composio-actions'
import { bindingSchema, routeSchema } from '@/lib/factory/contract'
import { factoryDispatchSchema } from '@/lib/factory/dispatch'
import * as steps from './steps'

/** Rounds of inbox per run; later events wait for the next wake. */
const MAX_ROUNDS = 10

/**
 * One wake of a person's Coordinator. Takes the lease, answers everything in
 * the inbox, and keeps going while new events arrive. A second wake that finds
 * the lease held exits at once, since the holder drains the inbox before it
 * lets go.
 */
export async function coordinatorTurn(userId: string) {
  'use workflow'
  const holder = getWorkflowMetadata().workflowRunId
  const agent = new WorkflowAgent({
    model: COORDINATOR_MODEL,
    tools: coordinatorTools(userId),
  })
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const inbox = await steps.takeInbox(userId, holder)
    if (!inbox.held) return
    if (!inbox.added) {
      if (await steps.releaseLease(userId, holder)) continue
      return
    }
    try {
      const { instructions, messages } = await steps.preparePrompt(userId)
      const result = await agent.generate({ instructions, messages, stopWhen: isStepCount(COORDINATOR_MAX_STEPS), prepareStep: coordinatorStep })
      // Every step's messages, not only the final step's: the tool calls and
      // results are history the next turn needs.
      await steps.appendMessages(userId, holder, result.responseMessages, turnWarning(result.finishReason, result.text))
    } catch (error) {
      // The messages stay in the conversation; the next wake answers them.
      await steps.failTurn(userId, holder, error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  await steps.releaseLease(userId, holder)
}

/** The Coordinator's tools. Each one runs as a step scoped to the person. */
function coordinatorTools(userId: string) {
  const id = z.uuid()
  return {
    ...createComposioAITools((action, input) => steps.composioAction(userId, action, input)),
    list_issues: tool({
      description: 'List the person\'s issues, most recently updated first. Optionally only one status (todo, doing, review, done and so on).',
      inputSchema: z.object({ status: z.string().optional() }),
      execute: input => steps.listIssues(userId, input),
    }),
    get_issue: tool({
      description: 'Read one issue: its text, status, priority and latest runs.',
      inputSchema: z.object({ issueId: id }),
      execute: input => steps.getIssue(userId, input),
    }),
    list_agents: tool({
      description: 'List the person\'s agents with their harness, whether their device is online, and the repositories on that device.',
      inputSchema: z.object({}),
      execute: () => steps.listAgents(userId),
    }),
    list_factory_requests: tool({
      description: 'Read recent authenticated requests to identify the source event for task routing.',
      inputSchema: z.object({}), execute: () => steps.listFactoryRequests(userId),
    }),
    route_factory_task: tool({
      description: 'Persist routing for the request and issue. Clear authorized work starts execute. Record only material missing information/permissions; spec is optional.',
      inputSchema: routeSchema.omit({ eventId: true }), execute: input => steps.routeFactoryTask(userId,input),
    }),
    get_factory_task: tool({
      description: 'Read durable routing, current binding, reasons, runs, attempts, candidate and evidence.',
      inputSchema: z.object({ taskId: id }), execute: input => steps.getFactoryTask(userId,input),
    }),
    resolve_factory_task: tool({
      description: 'Record only the missing items answered by a subsequent actual user request. Actual run permissions are checked again at dispatch.',
      inputSchema: z.object({ binding: bindingSchema, sourceEventId: id, rationale: z.string().min(1).max(4000), missingInformation: z.array(z.string().min(1).max(4000)).max(20), missingPermissions: z.array(z.string().min(1).max(4000)).max(20), needsSpec: z.boolean() }),
      execute: input => steps.resolveFactoryTask(userId,input),
    }),
    stop_factory_task: tool({
      description: 'Cancel the task or record withdrawn permission; stop bound runs and block later events.',
      inputSchema: z.object({ binding: bindingSchema, reason: z.string().min(1).max(4000), action: z.enum(['cancel','revoke']) }), execute: input => steps.stopFactoryTask(userId,input),
    }),
    dispatch_run: tool({
      description: 'Queue and bind one Factory run atomically. Use the exact current pending binding from route_factory_task/get_factory_task. Waiting, cancelled, revoked or stale tasks cannot dispatch. Reuse the same binding after a lost response.',
      inputSchema: factoryDispatchSchema,
      execute: input => steps.dispatchRun(userId, input),
    }),
    list_runs: tool({
      description: 'List recent runs, newest first, optionally for one issue or only those still going.',
      inputSchema: z.object({ issueId: id.optional(), activeOnly: z.boolean().optional() }),
      execute: input => steps.listRuns(userId, input),
    }),
    get_run: tool({
      description: 'Read one run: status, how it ended, the agent\'s summary, and its latest events.',
      inputSchema: z.object({ runId: id }),
      execute: input => steps.getRun(userId, input),
    }),
    send_to_run: tool({
      description: 'Send a message to a running agent. It reads it on its next poll.',
      inputSchema: z.object({ runId: id, text: z.string().min(1).max(10_000) }),
      execute: input => steps.sendToRun(userId, input),
    }),
    remember: tool({
      description: 'Save one short note to the person\'s memory, which you see in every conversation. Use it when the person asks you to remember something, or for a lasting preference or decision. Not for run status or anything that will soon change.',
      inputSchema: z.object({ note: z.string().min(1).max(500) }),
      execute: input => steps.remember(userId, input),
    }),
    forget: tool({
      description: 'Remove every memory line that contains this text. Use it when the person asks you to forget something or a note is no longer true.',
      inputSchema: z.object({ text: z.string().min(1).max(200) }),
      execute: input => steps.forget(userId, input),
    }),
    stop_run: tool({
      description: 'Ask a run to stop.',
      inputSchema: z.object({ runId: id }),
      execute: input => steps.stopRun(userId, input),
    }),
  }
}
