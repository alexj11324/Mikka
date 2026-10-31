'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { useLocale, useTranslations } from 'next-intl'
import { createContext, use, useRef, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { useIsStreaming } from '@openuidev/react-lang'
import { ApprovalCard, type ApprovalCardStatus } from '@/components/agents/approval-card'
import type { DateRangePickerLabels } from '@/components/motion/date-range-picker'
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
import { ConnectDeviceDialog } from '@/components/devices/connect-device-dialog'
import { E2BKeyDialog } from '@/components/settings/e2b-key-dialog'
import { usePresence } from '@/lib/use-presence'

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

  return <div className="flex w-full max-w-xl min-w-0 flex-col gap-2">
    <ApprovalCard
      title={props.title}
      description={props.description}
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

function useDateRangeLabels(): DateRangePickerLabels {
  const t = useTranslations('BeUi.dateRange')
  return {
    startDate: t('startDate'),
    endDate: t('endDate'),
    selectDate: t('selectDate'),
    selectEnd: t('selectEnd'),
    chooseMonth: t('chooseMonth'),
    chooseYear: t('chooseYear'),
    previousMonth: t('previousMonth'),
    nextMonth: t('nextMonth'),
    previousYear: t('previousYear'),
    nextYear: t('nextYear'),
    previousYears: t('previousYears'),
    nextYears: t('nextYears'),
    monthsIn: year => t('monthsIn', { year }),
    yearsFrom: (start, end) => t('yearsFrom', { start, end }),
    keyboardHelp: t('keyboardHelp'),
    daysSelected: count => t('daysSelected', { count }),
    chooseStartDate: t('chooseStartDate'),
    chooseEndDate: t('chooseEndDate'),
    clear: t('clear'),
    clearRange: t('clearRange'),
    startChosen: date => t('startChosen', { date }),
    unavailableRange: t('unavailableRange'),
    rangeSelected: (from, to) => t('rangeSelected', { from, to }),
    cleared: t('cleared'),
    presetSelected: name => t('presetSelected', { name }),
  }
}

export const AgentQuestions: AgentComponentRenderers['BeQuestions'] = ({ props }) => {
  const agentCopy = useAgentCopy()
  const locale = useLocale()
  const dateRangeLabels = useDateRangeLabels()

  const { send, sent, error, status } = useAgentDecision()
  const [summary, setSummary] = useState('')
  // A question with nothing to answer with (no options, control or free text) is a blank step that can never be
  // answered, so it also kept the submit button disabled; the schema forbids it, but streamed replies are not validated.
  // Neither are empty entries: the parser turns `,,` into null, which threw and failed the whole card.
  const questions = (props.questions ?? []).filter(present)
    .map(question => ({ ...question, ...(question.options ? { options: question.options.filter(present) } : {}), customPlaceholder: agentCopy.addAnotherAnswer }))
    .filter(answerable)

  if (questions.length === 0) return null
  const [only] = questions
  if (questions.length === 1 && !only.multiple && !only.input && only.options?.length) return <ChoiceCard title={only.title} options={only.options} task={props.task} />

  // Same width cap as ChoiceCard: about half the chat column.
  return <div className="flex w-full max-w-sm min-w-0 flex-col gap-2">
    <ApprovalCard
      questions={questions}
      // A switch or slider always has a value, so it can be submitted untouched.
      defaultAnswers={Object.fromEntries(questions.flatMap(question => question.input === 'switch' ? [[question.id, { selected: [], custom: agentCopy.answerNo }]]
        : question.input === 'slider' && question.range ? [[question.id, { selected: [], custom: `${question.range.min}${question.range.unit ?? ''}` }]] : []))}
      status={sent ? 'answered' : status}
      submitLabel={agentCopy.submitAnswersAndContinue}
      dateRangePicker={{ locale, labels: dateRangeLabels }}
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

type AgentQuestion = NonNullable<Parameters<AgentComponentRenderers['BeQuestions']>[0]['props']['questions']>[number]

function present<T>(value: T | null | undefined): value is T {
  return value !== null && typeof value === 'object'
}

function answerable(question: AgentQuestion) {
  return Boolean(question.options?.length || question.allowCustom || question.input === 'switch' || question.input === 'slider' || question.input === 'dateRange')
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
export const CLOUD_KEY_SETTINGS = '/settings?section=secrets'

/** Where the person connects a server: Settings › 电脑 (one-click SSH in the desktop app). */
export const CONNECT_SERVER_SETTINGS = '/settings?section=computers'

type ChoiceAction = 'cloudKeySettings' | 'enableThisMac' | 'connectServer' | 'e2bKey'

function ChoiceCard({ title, options, task }: { title: string; options: { value: string; label: string; action?: ChoiceAction }[]; task?: string }) {
  const agentCopy = useAgentCopy()
  const bubbles = use(ReplyBubbles)
  const answer = use(ReplyAnswer)
  const { send, sent, pending, error, status } = useAgentDecision()
  const [picked, setPicked] = useState<string | null>(null)
  // 这个任务需要一台电脑来跑 (waiting_machine): rows open the setup they name instead of answering.
  const [dialog, setDialog] = useState<'mac' | 'e2b' | null>(null)
  const e2bDialog = usePresence(dialog === 'e2b')
  const chosen = picked ?? options.find(option => [option.label, option.value === 'wait' ? agentCopy.dispatchWait : option.value === 'cloud' ? agentCopy.dispatchCloud : null].includes(answer?.trim() ?? ''))?.value ?? null
  const answered = sent || answer !== null
  // Dispatch options are localized by value (BE-13 sends English labels); anything else shows as written.
  const copy = (option: { value: string; label: string; action?: ChoiceAction }) => option.action === 'cloudKeySettings' ? agentCopy.cloudKeySetup
    : option.action === 'enableThisMac' ? agentCopy.needsMachineMac : option.action === 'connectServer' ? agentCopy.needsMachineServer : option.action === 'e2bKey' ? agentCopy.needsMachineE2B
    : option.value === 'wait' ? agentCopy.dispatchWait : option.value === 'cloud' ? agentCopy.dispatchCloud : option.label
  return <div role="group" aria-label={title} data-slot="choice-card" className="flex w-full max-w-sm min-w-0 flex-col gap-2">
    <p className={cn('w-fit max-w-full min-w-0', bubbles ? 'rounded-2xl bg-muted px-4 py-2.5' : 'font-medium')}>
      {task && <><CitationChip id={task.toLowerCase()} kind="issue" />{' '}</>}{title}
    </p>
    <div className="flex flex-col gap-1.5">
      {options.map((option, index) => {
        const selected = chosen === option.value
        const label = copy(option)
        const letter = String.fromCharCode(65 + index)
        // No E2B key yet: this row opens the settings where the key is set instead of answering. It stays an Item
        // once answered (dimmed, not a link) so the row never swaps component and jumps.
        if (option.action === 'cloudKeySettings' || option.action === 'connectServer') return <Item key={option.value} size="sm" variant="muted" aria-disabled={answered || undefined} className={cn(answered && 'pointer-events-none opacity-50')} render={answered ? <div /> : <Link href={option.action === 'connectServer' ? CONNECT_SERVER_SETTINGS : CLOUD_KEY_SETTINGS} />}>
          <ItemMedia><Kbd>{letter}</Kbd></ItemMedia>
          <ItemContent><ItemTitle>{label}</ItemTitle></ItemContent>
          <ItemActions><ChevronRight aria-hidden="true" /></ItemActions>
        </Item>
        // These open their setup in a dialog here; like the links above they never answer.
        if (option.action === 'enableThisMac' || option.action === 'e2bKey') return <Button key={option.value} type="button" variant="secondary" disabled={answered}
          onClick={() => setDialog(option.action === 'e2bKey' ? 'e2b' : 'mac')}>
          <Kbd data-icon="inline-start">{letter}</Kbd>{label}<ChevronRight data-icon="inline-end" aria-hidden="true" />
        </Button>
        // Answered rows stay the same Button, disabled, so nothing changes height or colour.
        return <Button key={option.value} type="button" variant={selected ? 'default' : 'secondary'} aria-pressed={selected}
          disabled={answered || status !== 'pending'} onClick={() => { setPicked(option.value); void send(label) }}>
          <Kbd data-icon="inline-start">{letter}</Kbd>{label}
          {selected && (pending ? <Spinner data-icon="inline-end" aria-label={agentCopy.sendingChoice} /> : answered && <Check data-icon="inline-end" aria-hidden="true" />)}
        </Button>
      })}
    </div>
    {error && <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:slide-in-from-bottom-0"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div>}
    <ConnectDeviceDialog open={dialog === 'mac'} onOpenChange={open => setDialog(open ? 'mac' : null)} hideTrigger />
    {e2bDialog.value && <E2BKeyDialog open={e2bDialog.open} onOpenChangeComplete={e2bDialog.onOpenChangeComplete} configured={false} onClose={() => setDialog(null)} />}
  </div>
}
