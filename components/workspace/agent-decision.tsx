'use client'

import { useRef, useState } from 'react'
import { useIsStreaming } from '@openuidev/react-lang'
import { ApprovalCard, type ApprovalCardStatus } from '@/components/agents/approval-card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useAgentInteraction } from './agent-interaction'
import { type AgentComponentRenderers } from '@/lib/agent-ui-catalog'

function useDecision() {
  const { busy, continueFromAnswer } = useAgentInteraction()
  const streaming = useIsStreaming()
  const locked = useRef(false)
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function send(prompt: string) {
    if (busy || streaming || locked.current || sent) return
    if (prompt.length > 8000) {
      setError('回答内容过长，请缩短补充内容后重新提交。')
      return
    }
    locked.current = true
    setPending(true)
    setError('')
    try {
      if (await continueFromAnswer(prompt)) setSent(true)
      else setError('本次继续未完成，选择和回答已保留，可以在此重试。')
    } catch {
      setError('提交失败，选择和回答已保留，请在此重试。')
    } finally {
      locked.current = false
      setPending(false)
    }
  }

  return { send, sent, error, status: (sent ? 'answered' : pending || busy || streaming ? 'submitting' : 'pending') as ApprovalCardStatus }
}

export const AgentApproval: AgentComponentRenderers['BeApproval'] = ({ props }) => {
  const { send, sent, error, status } = useDecision()
  const [decision, setDecision] = useState('')

  function choose(value: string) {
    setDecision(value)
    void send(`任务背景：${props.context}\n待确认建议：${props.title}\n方案说明：${props.description}\n我的意见：${value}。请据此继续提供建议，不要执行工作区操作。`)
  }

  return <div className="flex min-w-0 flex-col gap-2">
    <ApprovalCard
      title={props.title}
      description={<>{props.description}<span className="mt-2 block">在此选择后直接继续对话，不会授权工具或执行工作区操作。</span></>}
      status={sent ? 'answered' : status}
      approveLabel="同意并继续"
      onApprove={() => choose('同意这个建议方案')}
      onReject={() => choose('不同意这个建议方案')}
      onRequestChanges={() => choose('请修改这个建议方案')}
      result={`${decision}，已提交给 Agent；未执行工作区操作。`}
    />
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </div>
}

export const AgentQuestions: AgentComponentRenderers['BeQuestions'] = ({ props }) => {
  const { send, sent, error, status } = useDecision()
  const [summary, setSummary] = useState('')
  const questions = (props.questions ?? []).map(question => ({ ...question, autoAdvance: false, customPlaceholder: '补充其他回答…' }))

  if (questions.length === 0) return null

  return <div className="flex min-w-0 flex-col gap-2">
    <p className="text-xs text-muted-foreground">直接在此回答，提交后 Agent 会根据你的选择继续。</p>
    <ApprovalCard
      questions={questions}
      status={sent ? 'answered' : status}
      submitLabel="提交回答并继续"
      result={`回答已提交给 Agent。${summary}`}
      onSubmit={answers => {
        const response = questions.map(question => {
          const answer = answers[question.id]
          const selected = question.options?.filter(option => answer?.selected.includes(option.value)).map(option => option.label) ?? []
          return `${question.title}：${[...selected, answer?.custom?.trim()].filter(Boolean).join('；')}`
        }).join('\n')
        setSummary(response)
        void send(`任务背景：${props.context}\n我的回答：\n${response}\n请根据以上信息继续提供建议，不要执行工作区操作。`)
      }}
    />
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </div>
}
