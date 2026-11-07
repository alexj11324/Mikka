'use client'

import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { SettingsSection } from '@/components/settings/primitives'
import { cn } from '@/lib/utils'
import { useIssuePrefix } from '@/hooks/settings/use-preferences-page'

/** The four-letter prefix personal tasks show (MIK-46), e.g. ALEX-12. */
export function IssuePrefixSettings() {
  const t = useTranslations('Settings.issuePrefix')
  const { state, value, busy, message, commit, type, reset, description } = useIssuePrefix()
  return <SettingsSection id="issue-prefix-heading" title={t('title')}>
    <form onSubmit={event => { event.preventDefault(); commit() }}>
      <FieldGroup className="gap-0">
        <Field orientation="responsive" className="justify-between gap-3 px-5 py-4">
          <FieldContent>
            <FieldLabel htmlFor="issue-prefix">{t('label')}</FieldLabel>
            <FieldDescription>{description}</FieldDescription>
          </FieldContent>
          <Input id="issue-prefix" className="w-24 font-mono uppercase" maxLength={4} value={value} disabled={!state || busy} onBlur={commit}
            onChange={event => type(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') reset() }} />
        </Field>
        {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={cn('px-5 pb-4 text-sm', message.kind === 'error' ? 'text-destructive-foreground' : 'text-success-foreground')}>{message.text}</p>}
      </FieldGroup>
    </form>
  </SettingsSection>
}
