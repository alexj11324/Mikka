'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { SettingsSection } from '@/components/settings/primitives'
import { cn } from '@/lib/utils'
import { getIssuePrefixState, saveIssuePrefix } from '@/app/actions/issue-prefix'

type PrefixState = Awaited<ReturnType<typeof getIssuePrefixState>>

/** The four-letter prefix personal tasks show (MIK-46), e.g. ALEX-12. */
export function IssuePrefixSettings() {
  const t = useTranslations('Settings.issuePrefix')
  const [state, setState] = useState<PrefixState | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null)

  useEffect(() => {
    let active = true
    void getIssuePrefixState().then(next => {
      if (!active) return
      setState(next)
      setValue(next.prefix ?? next.saved ?? next.suggested ?? '')
    }).catch(() => { if (active) setMessage({ kind: 'error', text: t('loadError') }) })
    return () => { active = false }
  }, [t])

  async function save() {
    setBusy(true); setMessage(null)
    try {
      const result = await saveIssuePrefix({ prefix: value })
      if ('error' in result) { setMessage({ kind: 'error', text: result.error === 'issuePrefixTaken' ? t('taken') : t('invalid') }); return }
      setState(await getIssuePrefixState())
      setValue(result.prefix)
      setMessage({ kind: 'saved', text: t('saved', { example: `${result.prefix}-12` }) })
    } catch { setMessage({ kind: 'error', text: t('saveError') }) }
    finally { setBusy(false) }
  }

  const unchanged = value.trim().toUpperCase() === state?.prefix
  return <SettingsSection id="issue-prefix-heading" title={t('title')} description={t('description')}>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <FieldGroup className="gap-0">
        <Field orientation="responsive" className="justify-between gap-3 px-5 py-4">
          <FieldContent>
            <FieldLabel htmlFor="issue-prefix">{t('label')}</FieldLabel>
            <FieldDescription>{state && !state.prefix ? t('needsChoice') : t('current', { example: `${state?.prefix ?? 'ALEX'}-12` })}</FieldDescription>
          </FieldContent>
          <div className="flex items-center gap-2">
            <Input id="issue-prefix" className="w-24 font-mono uppercase" maxLength={4} value={value} disabled={!state || busy} onChange={event => setValue(event.target.value.replace(/[^a-z]/gi, '').toUpperCase())} />
            <Button type="submit" size="sm" disabled={!state || busy || value.length !== 4 || unchanged}>{t('save')}</Button>
          </div>
        </Field>
        {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={cn('px-5 pb-4 text-sm', message.kind === 'error' ? 'text-destructive' : 'text-success-foreground')}>{message.text}</p>}
      </FieldGroup>
    </form>
  </SettingsSection>
}
