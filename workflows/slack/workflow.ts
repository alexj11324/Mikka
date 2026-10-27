import { WorkflowAgent } from '@ai-sdk/workflow'
import { isStepCount } from 'ai'
import { COORDINATOR_MODEL, coordinatorStep } from '@/lib/coordinator/model'
import { AGENT_MAX_ROUNDS } from '@/lib/agent-rounds'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { coordinatorTools } from '@/workflows/coordinator/workflow'
import { postSlackReply } from './steps'

const SLACK_INSTRUCTIONS = `${COORDINATOR_INSTRUCTIONS}

This request comes from the person's verified Slack account. Reply in the same Slack thread.
Only the current @mention is available; ask for clarification when a reference is ambiguous.
Do not claim access to previous Slack messages or the private Mikka conversation.
Use plain issue/run ids with their titles in Slack; Slack does not render Mikka source chips.
A dispatched run completes separately in Mikka. Do not promise automatic completion updates in Slack; the person can @mention you to check its status.
Do not include private memories, unrelated issues, or other integration content unless the person asks for it in this request.`

export async function slackTurn(userId: string, threadId: string, text: string) {
  'use workflow'
  const agent = new WorkflowAgent({ model: COORDINATOR_MODEL, tools: coordinatorTools(userId, null) })
  try {
    const result = await agent.generate({
      instructions: SLACK_INSTRUCTIONS,
      messages: [{ role: 'user', content: text }],
      stopWhen: isStepCount(AGENT_MAX_ROUNDS),
      prepareStep: coordinatorStep,
    })
    await postSlackReply(threadId, result.text || '请补充具体的任务、agent 或设备。')
  } catch {
    await postSlackReply(threadId, '这次请求处理失败，请稍后 @Mikka 重试，或在 Mikka 中查看任务状态。')
  }
}
