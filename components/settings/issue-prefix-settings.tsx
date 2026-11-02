'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { SettingsSection } from '@/components/settings/primitives'
import { cn } from '@/lib/utils'
import { getIssuePrefixState, saveIssuePrefix } from '@/app/actions/issue-prefix'

type PrefixState = Awaited<ReturnType<typeof getIssuePrefixState>>

/** The four-letter prefix personal tasks show (MIK-46), e.g. ALEX-12. */
export function IssuePrefixSettings() {
  const t = useTranslations('Settings.issuePrefix')
  // Cached: a return to 偏好 shows the saved prefix at once and re-reads it behind.
  const read = useSWR('settings:issue-prefix', getIssuePrefixState)
  const state: PrefixState | null = read.data ?? null
  const shown = (next: PrefixState | null) => next?.prefix ?? next?.saved ?? next?.suggested ?? ''
  /** What the person typed; null shows the saved prefix. */
  const [draft, setValue] = useState<string | null>(null)
  const value = draft ?? shown(state)
  const [busy, setBusy] = useState(false)
  const [actionMessage, setMessage] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null)
  const message = actionMessage ?? (read.error && !read.data ? { kind: 'error' as const, text: t('loadError') } : null)

  async function save() {
    setBusy(true); setMessage(null)
    try {
      const result = await saveIssuePrefix({ prefix: value })
      if ('error' in result) { setMessage({ kind: 'error', text: result.error === 'issuePrefixTaken' ? t('taken') : t('invalid') }); return }
      await read.mutate()
      setValue(null)
      setMessage({ kind: 'saved', text: t('saved', { example: `${result.prefix}-12` }) })
    } catch { setMessage({ kind: 'error', text: t('saveError') }) }
    finally { setBusy(false) }
  }

  const unchanged = value.trim().toUpperCase() === state?.prefix
  // Saves when the field is left or on Enter, as the other settings fields do; an incomplete prefix goes back to the saved one.
  function commit() {
    if (!state || busy || unchanged) return
    if (value.length === 4) { void save(); return }
    if (state.prefix) setValue(null)
  }
  return <SettingsSection id="issue-prefix-heading" title={t('title')}>
    <form onSubmit={event => { event.preventDefault(); commit() }}>
      <FieldGroup className="gap-0">
        <Field orientation="responsive" className="justify-between gap-3 px-5 py-4">
          <FieldContent>
            <FieldLabel htmlFor="issue-prefix">{t('label')}</FieldLabel>
            <FieldDescription>{state && !state.prefix ? t('needsChoice') : t('current', { example: `${state?.prefix ?? 'ALEX'}-12` })}</FieldDescription>
          </FieldContent>
          <Input id="issue-prefix" className="w-24 font-mono uppercase" maxLength={4} value={value} disabled={!state || busy} onBlur={commit}
            onChange={event => setValue(event.target.value.replace(/[^a-z]/gi, '').toUpperCase())}
            onKeyDown={event => { if (event.key === 'Escape' && state) setValue(null) }} />
        </Field>
        {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={cn('px-5 pb-4 text-sm', message.kind === 'error' ? 'text-destructive' : 'text-success-foreground')}>{message.text}</p>}
      </FieldGroup>
    </form>
  </SettingsSection>
}
