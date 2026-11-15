'use client'

import { useDecisionSubmission } from '@/hooks/use-decision-submission'
import { useAgentCopy } from '@/hooks/use-agent-copy'
import { useLocale, useTranslations } from 'next-intl'
import { createContext, use, useState, type ReactElement, type ReactNode } from 'react'
import { Check, ChevronRight, ExternalLink } from 'lucide-react'
import { GITHUB_APP_INSTALL_URL } from '@/lib/github/repository-match'
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
import { useActionError } from '@/lib/use-action-error'
import { setDeviceEnabled } from '@/app/actions/agents'

export function useAgentDecision() {
  const agentCopy = useAgentCopy()

  const { busy, continueFromAnswer, answer } = useAgentInteraction()
  const streaming = useIsStreaming()
  const operation = useDecisionSubmission()
  const receipt = operation.state('reply')
  const pending = receipt.status === 'submitting'
  const sent = receipt.status === 'accepted'

  async function send(prompt: string) {
    if (busy || streaming) return
    await operation.submit('reply', async () => {
      if (!prompt.trim() || prompt.length > 8000) return { status: 'failed', error: agentCopy.theQuestionIsEmptyOrTooLong2 }
      // The card says why the answer did not go when the chat knows (offline, refresh needed, the server's reason);
      // the general sentence is only for a send that gives none.
      const outcome = answer ? await answer(prompt) : { sent: await continueFromAnswer(prompt) }
      return outcome.sent ? { status: 'accepted' } : { status: 'failed', error: ('reason' in outcome && outcome.reason) || agentCopy.unableToContinueYourChoicesAndAnswers }
    }, agentCopy.submissionFailedYourChoicesAndAnswersAre)
  }

  return { send, sent, pending, error: 'error' in receipt ? receipt.error : '', status: (sent ? 'answered' : pending || busy || streaming ? 'submitting' : 'pending') as ApprovalCardStatus }
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
  if (questions.length === 1 && !only.multiple && !only.input && only.options?.length) return <ChoiceCard title={only.title} description={only.description} options={only.options} task={props.task} />

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
 * rows lettered A, B, C…; a click is the reply. The picked row is marked with
 * a check; the others stay readable. Anything else goes through the composer.
 */
/** Where the user stores their own E2B key (the cloud computer runs on it). */
export const CLOUD_KEY_SETTINGS = '/settings?section=models'

/** Where the person connects a server: Settings › 电脑 (one-click SSH in the desktop app). */
export const CONNECT_SERVER_SETTINGS = '/settings?section=computers'
/** 模型与订阅: where the allowed models and 运行位置 are set (decision 2026-11-02-1400). */
export const MODEL_SETTINGS = '/settings?section=models'

type ChoiceAction = 'cloudKeySettings' | 'enableThisMac' | 'connectServer' | 'e2bKey' | 'allowAutoSchedule' | 'serverOnline' | 'modelSettings' | 'githubInstall'

function ChoiceCard({ title, description, options, task }: { title: string; description?: string; options: { value: string; label: string; action?: ChoiceAction }[]; task?: string }) {
  const agentCopy = useAgentCopy()
  const bubbles = use(ReplyBubbles)
  const answer = use(ReplyAnswer)
  const { send, sent, pending, error, status } = useAgentDecision()
  const actionError = useActionError()
  const [picked, setPicked] = useState<string | null>(null)
  // 没有可用的电脑 (waiting_machine): rows open the setup they name instead of answering.
  const [dialog, setDialog] = useState<'mac' | 'e2b' | null>(null)
  const e2bDialog = usePresence(dialog === 'e2b')
  const [autoError, setAutoError] = useState('')
  async function allowAutoSchedule(deviceId: string, label: string) {
    setAutoError('')
    const result = await setDeviceEnabled({ deviceId, enabled: true }).catch(() => ({ error: 'deviceSaveFailed' as const }))
    if ('error' in result) { setAutoError(actionError(result.error)); return }
    setPicked(deviceId)
    void send(label)
  }
  const chosen = picked ?? options.find(option => [option.label, option.value === 'wait' ? agentCopy.dispatchWait : option.value === 'cloud' ? agentCopy.dispatchCloud : null].includes(answer?.trim() ?? ''))?.value ?? null
  const answered = sent || answer !== null
  // Dispatch options are localized by value (BE-13 sends English labels); anything else shows as written.
  const copy = (option: { value: string; label: string; action?: ChoiceAction }) => option.action === 'cloudKeySettings' ? agentCopy.cloudKeySetup
    : option.action === 'enableThisMac' ? agentCopy.needsMachineMac : option.action === 'connectServer' ? agentCopy.needsMachineConnect : option.action === 'e2bKey' ? agentCopy.needsMachineE2B
    : option.action === 'allowAutoSchedule' ? agentCopy.needsMachineAuto : option.action === 'serverOnline' ? agentCopy.needsMachineServerOnline
    : option.action === 'modelSettings' ? agentCopy.needsModelSettings : option.action === 'githubInstall' ? agentCopy.githubInstallMore
    : option.value === 'wait' ? agentCopy.dispatchWait : option.value === 'cloud' ? agentCopy.dispatchCloud : option.label
  return <div role="group" aria-label={title} data-slot="choice-card" className="flex w-full max-w-sm min-w-0 flex-col gap-2">
    <p data-choice-title="" className={cn('w-fit max-w-full min-w-0', bubbles ? 'rounded-2xl bg-muted px-4 py-2.5' : 'font-medium')}>
      {task && <><CitationChip id={task.toLowerCase()} kind="issue" />{' '}</>}{title}
    </p>
    {/* What the person must do first (没有可用的电脑): one line under the question, not a bubble of its own. */}
    {description && <p data-choice-description="" className="text-sm text-muted-foreground">{description}</p>}
    <div data-choice-rows="" className="flex flex-col gap-1.5">
      {options.map((option, index) => {
        const selected = chosen === option.value
        const label = copy(option)
        const row = { letter: String.fromCharCode(65 + index), label, selected, answered }
        const done = selected && (pending ? <Spinner aria-label={agentCopy.sendingChoice} /> : answered && <Check aria-hidden="true" />)
        const opens = <ChevronRight aria-hidden="true" />
        // Once answered every row is plain text: the picked one marked, the others still readable (Claude, ChatGPT).
        if (answered) return <ChoiceRow key={option.value} {...row} render={<div />} end={done || null} />
        // No E2B key yet, 没有可用的电脑, a model to allow: the row opens the setup it names instead of answering.
        if (option.action === 'cloudKeySettings' || option.action === 'connectServer' || option.action === 'serverOnline' || option.action === 'modelSettings')
          return <ChoiceRow key={option.value} {...row} end={opens} render={<Link href={option.action === 'cloudKeySettings' ? CLOUD_KEY_SETTINGS : option.action === 'modelSettings' ? MODEL_SETTINGS : CONNECT_SERVER_SETTINGS} />} />
        // 已授权的仓库里没有: the GitHub App's page opens in a new tab, where the person adds repositories; nothing is answered.
        if (option.action === 'githubInstall') return <ChoiceRow key={option.value} {...row} end={<ExternalLink aria-hidden="true" />} render={<a href={GITHUB_APP_INSTALL_URL} target="_blank" rel="noopener noreferrer" />} />
        if (option.action === 'enableThisMac' || option.action === 'e2bKey') return <ChoiceRow key={option.value} {...row} end={opens}
          render={<Button variant="bare" onClick={() => setDialog(option.action === 'e2bKey' ? 'e2b' : 'mac')} />} />
        const busy = status !== 'pending'
        // 没有可用的电脑: 让这台电脑参与调度 switches that device on, then tells the bot to dispatch again.
        return <ChoiceRow key={option.value} {...row} end={done || null} render={<Button variant="bare" aria-pressed={selected} disabled={busy}
          onClick={() => { if (option.action === 'allowAutoSchedule') void allowAutoSchedule(option.value, label); else { setPicked(option.value); void send(label) } }} />} />
      })}
    </div>
    {(error || autoError) && <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:slide-in-from-bottom-0"><Alert variant="destructive"><AlertDescription>{error || autoError}</AlertDescription></Alert></div>}
    <ConnectDeviceDialog open={dialog === 'mac'} onOpenChange={open => setDialog(open ? 'mac' : null)} hideTrigger />
    {e2bDialog.value && <E2BKeyDialog open={e2bDialog.open} onOpenChangeComplete={e2bDialog.onOpenChangeComplete} configured={false} onClose={changed => {
      setDialog(null)
      const e2b = options.find(option => option.action === 'e2bKey')
      if (changed && e2b && !answered) { setPicked(e2b.value); void send(copy(e2b)) }
    }} />}
  </div>
}

/**
 * One lettered row of a choice card: the library's Item, left-aligned, its letter a Kbd. It looks the same whether it
 * answers, opens a setup page or a dialog; `render` decides which (the shared Button, a link, or a plain row once
 * answered). Item's look wins over the bare Button's sizing. Open rows sit on the page surface, a step above the reply
 * they are in, so they read as the thing to press in both themes (UI audit chat-07).
 */
function ChoiceRow({ letter, label, selected, answered, end, render }: { letter: string; label: string; selected: boolean; answered: boolean; end: ReactNode; render: ReactElement }) {
  return <Item size="sm" variant="outline" data-choice={selected ? 'picked' : answered ? 'other' : 'open'} render={render}
    className={cn('h-auto justify-start text-left whitespace-normal disabled:opacity-100', !answered && 'cursor-pointer bg-background shadow-xs hover:bg-muted disabled:cursor-default disabled:hover:bg-background', selected && 'border-primary/40 bg-muted', answered && !selected && 'text-muted-foreground')}>
    <ItemMedia><Kbd>{letter}</Kbd></ItemMedia>
    <ItemContent><ItemTitle className={cn('line-clamp-none font-normal', selected && 'font-medium')}>{label}</ItemTitle></ItemContent>
    {end && <ItemActions className="text-muted-foreground [&_svg]:size-4">{end}</ItemActions>}
  </Item>
}
