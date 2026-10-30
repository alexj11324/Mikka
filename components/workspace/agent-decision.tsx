'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { createContext, use, useRef, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { useIsStreaming } from '@openuidev/react-lang'
import { ApprovalCard, type ApprovalCardStatus } from '@/components/agents/approval-card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { useAgentInteraction } from './agent-interaction'
import { CitationChip } from './agent-citations'
import { ReplyBubbles } from './agent-text-bubble'
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

  return { send, sent, pending, error, status: (sent ? 'answered' : pending || busy || streaming ? 'submitting' : 'pending') as ApprovalCardStatus }
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
  if (questions.length === 1 && !only.multiple && only.options?.length) return <ChoiceCard title={only.title} options={only.options} task={props.task} />

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
 * What the person said right after this reply, when the host knows it: a
 * choice card shows that answer picked after a reload (Figma 379:5694).
 */
export const ReplyAnswer = createContext<string | null>(null)

/**
 * One question with a few answers (Figma 379:5694, 395:24805, 395:24642): the
 * question in the reply's bubble, an optional task chip ahead of it, then grey
 * rows lettered A, B, C…; a click is the reply. The picked row turns dark with
 * a check and the others dim. Anything else goes through the composer.
 */
/** Where the user stores their own E2B key (the cloud computer runs on it). */
export const CLOUD_KEY_SETTINGS = '/settings?section=integrations'

function ChoiceCard({ title, options, task }: { title: string; options: { value: string; label: string; action?: 'cloudKeySettings' }[]; task?: string }) {
  const agentCopy = useAgentCopy()
  const bubbles = use(ReplyBubbles)
  const answer = use(ReplyAnswer)
  const { send, sent, pending, error, status } = useAgentDecision()
  const [picked, setPicked] = useState<string | null>(null)
  const chosen = picked ?? options.find(option => option.label === answer?.trim())?.value ?? null
  const answered = sent || answer !== null
  return <div role="group" aria-label={title} data-slot="choice-card" className="flex w-full max-w-xl min-w-0 flex-col gap-2">
    <p className={cn('w-fit max-w-full min-w-0', bubbles ? 'rounded-2xl bg-muted px-4 py-2.5' : 'font-medium')}>
      {task && <><CitationChip id={task.toLowerCase()} kind="issue" />{' '}</>}{title}
    </p>
    <div role={answered && !pending ? 'list' : undefined} className="flex flex-col gap-1.5">
      {options.map((option, index) => {
        const selected = chosen === option.value
        const label = option.action === 'cloudKeySettings' ? agentCopy.cloudKeySetup : option.label
        const body = <>
          <ItemMedia><Kbd>{String.fromCharCode(65 + index)}</Kbd></ItemMedia>
          <ItemContent><ItemTitle>{label}</ItemTitle></ItemContent>
          {selected && <ItemActions>{pending ? <Spinner aria-label={agentCopy.sendingChoice} /> : <Check aria-hidden="true" />}</ItemActions>}
        </>
        // Answered: the rows are a record, not controls.
        if (answered && !pending) return <Item key={option.value} role="listitem" size="sm" variant={selected ? 'muted' : 'default'} aria-current={selected || undefined}>{body}</Item>
        // No E2B key yet: this option opens the settings where the key is set instead of answering.
        if (option.action === 'cloudKeySettings') return <Item key={option.value} size="sm" variant="outline" render={<Link href={CLOUD_KEY_SETTINGS} />}>{body}<ItemActions><ChevronRight aria-hidden="true" /></ItemActions></Item>
        return <Button key={option.value} type="button" variant={selected ? 'default' : 'outline'} aria-pressed={selected}
          disabled={status !== 'pending'} onClick={() => { setPicked(option.value); void send(option.label) }}>
          <Kbd data-icon="inline-start">{String.fromCharCode(65 + index)}</Kbd>{label}{selected && <Spinner data-icon="inline-end" aria-label={agentCopy.sendingChoice} />}
        </Button>
      })}
    </div>
    {error && <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:slide-in-from-bottom-0"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div>}
  </div>
}
