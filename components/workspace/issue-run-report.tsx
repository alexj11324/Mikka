'use client'

import { useTranslations } from 'next-intl'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import { AgentMarkdown } from './agent-markdown'

/** Reports are durable, versioned data. Render known fields, retain unknown ones as text. */
export function IssueRunReport({ report }: { report: unknown }) {
  const t = useTranslations('IssueRuns')
  if (!report || typeof report !== 'object' || Array.isArray(report)) return <section aria-label={t('report')}><h3 className="text-sm font-semibold">{t('report')}</h3><p className="whitespace-pre-wrap break-words text-sm">{String(report ?? '')}</p></section>
  const record = report as Record<string, unknown>
  const fields = ['summary', 'filesChanged', 'verify', 'openQuestions', 'nextStep', 'blockedOn', 'knownIssues', 'notesForNext'] as const
  const other = Object.fromEntries(Object.entries(record).filter(([key]) => !fields.some(field => field === key)))
  function content(value: unknown) {
    if (typeof value === 'string') return <AgentMarkdown text={value} />
    if (Array.isArray(value)) return <ul className="list-disc pl-4">{value.map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">{typeof item === 'string' ? item : JSON.stringify(item)}</li>)}</ul>
    return <pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(value, null, 2)}</pre>
  }
  return <section aria-label={t('report')} className="flex flex-col gap-3"><h3 className="text-sm font-semibold">{t('report')}</h3>{fields.map(field => {
    const value = record[field]
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return null
    return <section key={field} aria-label={t(field)}><h4 className="text-xs font-medium text-muted-foreground">{t(field)}</h4>{field === 'verify' && typeof value === 'object' && !Array.isArray(value) ? <dl className="flex flex-col gap-1 text-sm">{(['status', 'command', 'output'] as const).map(key => {
      const detail = (value as Record<string, unknown>)[key]
      return detail == null ? null : <div key={key} className="flex flex-col gap-0.5"><dt className="text-xs text-muted-foreground">{key === 'output' ? t('verifyOutput') : t(key)}</dt><dd className="whitespace-pre-wrap break-words">{String(detail)}</dd></div>
    })}</dl> : content(value)}</section>
  })}{Object.keys(other).length > 0 && <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>{t('otherReport')}</CollapsibleTrigger><CollapsibleContent>{content(other)}</CollapsibleContent></Collapsible>}</section>
}
