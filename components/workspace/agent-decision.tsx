'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { useRef, useState } from 'react'
import { useIsStreaming } from '@openuidev/react-lang'
import { ApprovalCard, type ApprovalCardStatus } from '@/components/agents/approval-card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAgentInteraction } from './agent-interaction'
import { type AgentComponentRenderers } from '@/lib/agent-ui-catalog'

export function useAgentDecision() {
  const agentCopy = useAgentCopy()

  const { busy, continueFromAnswer } = useAgentInteraction()
  const streaming = useIsStreaming()
  const locked = useRef(false)
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function send(prompt: string) {
    if (busy || streaming || locked.current || sent) return
    if (!prompt.trim() || prompt.length > 8000) {
      setError(agentCopy.theQuestionIsEmptyOrTooLong2)
      return
    }
    locked.current = true
    setPending(true)
    setError('')
    try {
      if (await continueFromAnswer(prompt)) setSent(true)
      else setError(agentCopy.unableToContinueYourChoicesAndAnswers)
    } catch {
      setError(agentCopy.submissionFailedYourChoicesAndAnswersAre)
    } finally {
      locked.current = false
      setPending(false)
    }
  }

  return { send, sent, error, status: (sent ? 'answered' : pending || busy || streaming ? 'submitting' : 'pending') as ApprovalCardStatus }
}

export const AgentApproval: AgentComponentRenderers['BeApproval'] = ({ props }) => {
  const agentCopy = useAgentCopy()

  const { send, sent, error, status } = useAgentDecision()
  const [decision, setDecision] = useState('')

  function choose(value: string) {
    setDecision(value)
    void send((agentCopy.taskContext + (props.context) + agentCopy.proposal + (props.title) + agentCopy.description + (props.description) + agentCopy.myDecision + (value) + agentCopy.ContinueAdvisingBasedOnThisWithout))
  }

  return <div className="flex min-w-0 flex-col gap-2">
    <ApprovalCard
      title={props.title}
      description={<>{props.description}<span className="mt-2 block">{agentCopy.chooseHereToContinueThisDoesNot}</span></>}
      status={sent ? 'answered' : status}
      approveLabel={agentCopy.approveAndContinue}
      onApprove={() => choose(agentCopy.iApproveThisProposal)}
      onReject={() => choose(agentCopy.iRejectThisProposal)}
      onRequestChanges={() => choose(agentCopy.pleaseReviseThisProposal)}
      result={((decision) + agentCopy.SubmittedToAgentNoWorkspaceOperations)}
    />
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </div>
}

export const AgentQuestions: AgentComponentRenderers['BeQuestions'] = ({ props }) => {
  const agentCopy = useAgentCopy()

  const { send, sent, error, status } = useAgentDecision()
  const [summary, setSummary] = useState('')
  const questions = (props.questions ?? []).map(question => ({ ...question, autoAdvance: false, customPlaceholder: agentCopy.addAnotherAnswer }))

  if (questions.length === 0) return null
  const [only] = questions
  if (questions.length === 1 && !only.multiple && only.options?.length) return <ChoiceCard title={only.title} options={only.options} />

  return <div className="flex min-w-0 flex-col gap-2">
    <p className="text-xs text-muted-foreground">{agentCopy.answerHereAgentWillContinueBasedOn}</p>
    <ApprovalCard
      questions={questions}
      status={sent ? 'answered' : status}
      submitLabel={agentCopy.submitAnswersAndContinue}
      result={(agentCopy.answersSubmittedToAgent + (summary))}
      onSubmit={answers => {
        const response = questions.map(question => {
          const answer = answers[question.id]
          const selected = question.options?.filter(option => answer?.selected.includes(option.value)).map(option => option.label) ?? []
          return `${question.title}：${[...selected, answer?.custom?.trim()].filter(Boolean).join('；')}`
        }).join('\n')
        setSummary(response)
        void send((agentCopy.taskContext + (props.context) + agentCopy.myAnswers + (response) + agentCopy.continueAdvisingBasedOnThisInformationWithout))
      }}
    />
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </div>
}

/**
 * One question with a few answers (Figma 208:4780, Grok style): a bordered
 * card, options lettered A, B, C…; a click is the reply. Anything else the
 * person wants to say goes through the composer.
 */
function ChoiceCard({ title, options }: { title: string; options: { value: string; label: string }[] }) {
  const { send, error, status } = useAgentDecision()
  const [picked, setPicked] = useState<string | null>(null)
  return <div className="flex w-full max-w-xl min-w-0 flex-col gap-2 rounded-2xl border p-4">
    <p className="px-2 pb-1 font-medium">{title}</p>
    {options.map((option, index) => <Button key={option.value} type="button" variant="ghost" className={cn('h-auto justify-start gap-3 px-2 py-2 text-left font-normal whitespace-normal', picked === option.value && 'bg-muted')}
      disabled={status !== 'pending'} onClick={() => { setPicked(option.value); void send(option.label) }}>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md border text-xs text-muted-foreground">{String.fromCharCode(65 + index)}</span>{option.label}
    </Button>)}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </div>
}
