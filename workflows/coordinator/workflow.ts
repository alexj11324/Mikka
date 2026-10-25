import { WorkflowAgent } from '@ai-sdk/workflow'
import { isStepCount, tool } from 'ai'
import { getWorkflowMetadata } from 'workflow'
import { z } from 'zod'
import { COORDINATOR_MAX_STEPS, COORDINATOR_MODEL, coordinatorStep, turnWarning } from '@/lib/coordinator/model'
import { createComposioAITools, createGoogleAITools } from '@/lib/composio-actions'
import * as steps from './steps'
import { createCredentialAITools } from '@/lib/credentials/ai-tools'

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
    ...createCredentialAITools((name, input) => steps.credentialTool(userId, name, input)),
    ...createComposioAITools((action, input) => steps.composioAction(userId, action, input)),
    ...createGoogleAITools((action, input) => steps.composioAction(userId, action, input), (action, input) => steps.proposeAccountAction(userId, action, input)),
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
    dispatch_run: tool({
      description: 'Queue a run: one agent works one issue in one repository on its device. Returns the run id at once; an [Event] message arrives when the run ends.',
      inputSchema: z.object({
        issueId: id, agentId: id,
        deviceRepoId: id.describe('A repository id from list_agents, on the agent\'s own device.'),
        note: z.string().max(10_000).optional().describe('Extra direction for this run, added after the issue text.'),
      }),
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
