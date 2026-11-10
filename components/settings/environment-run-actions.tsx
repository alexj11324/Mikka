'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Play, Square } from 'lucide-react'
import type { EligibleActionRun } from '@/lib/environments/runs'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isTerminalRunActionStatus, type RunActionExecutionView } from '@/lib/environments/contract'
import {
  cancelRunAction, requestRunAction, RunActionRequestError, useRunActionExecution, useRunActions,
} from './environments-data'
import { SettingsSection } from './primitives'

/** 设置 › 运行环境 › 试运行: one environment action on a live cloud run. The
 * commands and their output stay separate from the Agent's tool steps. */
export function EnvironmentRunActions({ workspaceId, runs }: { workspaceId: string; runs: EligibleActionRun[] }) {
  const t = useTranslations('Settings.environments')
  const [runId, setRunId] = useState<string | null>(null)
  const [actionId, setActionId] = useState('')
  const [executionId, setExecutionId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const requestKey = useRef<string | null>(null)
  const actions = useRunActions(runId, workspaceId)
  const execution = useRunActionExecution(runId, executionId, workspaceId)
  const view = actions.data
  const available = view?.environment?.actions ?? []

  useEffect(() => {
    setActionId('')
    setExecutionId(null)
    setFailure(null)
    requestKey.current = null
  }, [runId])
  useEffect(() => {
    if (!actionId && available.length) setActionId(available[0]!.id)
  }, [actionId, available])
  useEffect(() => {
    if (!executionId && view?.executions.length) setExecutionId(view.executions[0]!.id)
  }, [executionId, view?.executions])

  async function run() {
    if (!runId || !actionId || pending) return
    setPending(true); setFailure(null)
    requestKey.current ??= crypto.randomUUID()
    try {
      const result = await requestRunAction(runId, actionId, requestKey.current)
      setExecutionId(result.execution.id)
      requestKey.current = null
      void actions.mutate()
    } catch (error) {
      setFailure(error instanceof RunActionRequestError ? error.code : 'environmentUnavailable')
    } finally { setPending(false) }
  }

  async function cancel() {
    if (!runId || !executionId) return
    setFailure(null)
    try {
      await cancelRunAction(runId, executionId)
      void execution.mutate()
    } catch (error) {
      setFailure(error instanceof RunActionRequestError ? error.code : 'environmentUnavailable')
    }
  }

  const current = execution.data?.execution ?? null
  const busy = Boolean(current && !isTerminalRunActionStatus(current.status))
  const describeRun = (run: EligibleActionRun) => `${run.issueTitle ?? run.id.slice(0, 8)} · ${t.has(`runStatus.${run.status}` as never) ? t(`runStatus.${run.status}` as never) : run.status}`

  return <SettingsSection id="environment-run-actions" title={t('tryTitle')} description={t('tryDescription')}>
    <div className="flex flex-col gap-3 px-5 py-4">
      {runs.length === 0 && <p className="text-sm text-muted-foreground">{t('noLiveRuns')}</p>}
      {runs.length > 0 && <div className="grid gap-2 sm:grid-cols-2">
        <Select value={runId ?? undefined} onValueChange={setRunId} items={runs.map(run => ({ value: run.id, label: describeRun(run) }))}>
          <SelectTrigger className="w-full" aria-label={t('chooseRun')}><SelectValue placeholder={t('chooseRun')} /></SelectTrigger>
          <SelectContent><SelectGroup>{runs.map(run => <SelectItem key={run.id} value={run.id}>{describeRun(run)}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
        <Select value={actionId || undefined} disabled={!available.length} onValueChange={value => { if (value) setActionId(value) }} items={available.map(action => ({ value: action.id, label: `${action.name} · ${t(`kinds.${action.kind}`)}` }))}>
          <SelectTrigger className="w-full" aria-label={t('chooseAction')}><SelectValue placeholder={t('chooseAction')} /></SelectTrigger>
          <SelectContent><SelectGroup>{available.map(action => <SelectItem key={action.id} value={action.id}>{action.name} · {t(`kinds.${action.kind}`)}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </div>}
      {runId && view && !view.environment && <p className="text-sm text-muted-foreground">{t('runWithoutEnvironment')}</p>}
      {runId && view?.environment && view.machine !== 'cloud_running' && <p className="text-sm text-muted-foreground">{view.machine === 'local' ? t('localUnsupported') : t('machineUnavailable')}</p>}
      {runId && view?.environment && <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{t('frozenAt', { name: view.environment.name, revision: view.environment.revision })}</span>
        {busy && <Badge variant="secondary">{t(`status.${current!.status}`)}</Badge>}
      </div>}
      {runId && view?.environment && view.machine === 'cloud_running' && <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={!actionId || pending || busy} onClick={() => void run()}><Play data-icon="inline-start" />{pending ? t('starting') : t('runAction')}</Button>
        {busy && <Button type="button" size="sm" variant="outline" onClick={() => void cancel()}><Square data-icon="inline-start" />{t('cancelAction')}</Button>}
      </div>}
      {failure && <FieldError>{t.has(`errors.${failure}` as never) ? t(`errors.${failure}` as never) : t('errors.generic')}</FieldError>}
      {current && <ExecutionLog execution={current} />}
    </div>
  </SettingsSection>
}

function ExecutionLog({ execution }: { execution: RunActionExecutionView }) {
  const t = useTranslations('Settings.environments')
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{execution.actionName} · {t(`status.${execution.status}`)}</span>
      {execution.exitCode !== null && <span>{t('exitCode', { code: execution.exitCode })}</span>}
      {execution.startedAt && <span>{t('startedAt', { time: new Date(execution.startedAt).toLocaleTimeString() })}</span>}
      {execution.finishedAt && <span>{t('finishedAt', { time: new Date(execution.finishedAt).toLocaleTimeString() })}</span>}
    </div>
    {execution.stdout && <pre aria-label={t('stdout')} className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{execution.stdout}</pre>}
    {execution.stderr && <pre aria-label={t('stderr')} className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-destructive">{execution.stderr}</pre>}
    {!execution.stdout && !execution.stderr && <p className="text-xs text-muted-foreground">{t('noOutput')}</p>}
    {execution.truncated && <p className="text-xs text-muted-foreground">{t('outputTruncated')}</p>}
  </div>
}
