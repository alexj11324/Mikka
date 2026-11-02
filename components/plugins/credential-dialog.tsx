'use client'

import { useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowUpRight, LockIcon } from 'lucide-react'
import { toast } from 'sonner'

import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { useAppDetail, useAppInfo, type ConnectedApps } from '@/components/plugins/connected-apps'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'

/** Which app's form is open, and the account a new key replaces. */
export type CredentialTarget = { app: string; replaceAccountId?: string }

/**
 * Connecting an app with the person's own key (decision 2026-11-02). The
 * fields are Composio's for the app's scheme. What was typed is sent once and
 * cleared from the form as it is sent, whatever the outcome.
 */
export function CredentialDialog({ apps, target, onClose }: { apps: ConnectedApps; target: CredentialTarget | null; onClose: () => void }) {
  const t = useTranslations('Plugins.key')
  const { name } = useAppInfo()(target?.app ?? '')
  return <Dialog open={Boolean(target)} onOpenChange={open => { if (!open && !apps.pending) onClose() }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{target?.replaceAccountId ? t('replaceTitle', { name }) : t('title', { name })}</DialogTitle></DialogHeader>
      {/* Keyed by app and account, so nothing typed for one survives into another. */}
      {target && <CredentialForm key={`${target.app}:${target.replaceAccountId ?? ''}`} apps={apps} target={target} onClose={onClose} />}
    </DialogContent>
  </Dialog>
}

function CredentialForm({ apps, target, onClose }: { apps: ConnectedApps; target: CredentialTarget; onClose: () => void }) {
  const t = useTranslations('Plugins.key')
  const common = useTranslations('Common')
  const { name } = useAppInfo()(target.app)
  const detail = useAppDetail(target.app)
  const forms = detail.data?.auth.forms ?? []
  const [scheme, setScheme] = useState<string | null>(null)
  const form = forms.find(item => item.scheme === scheme) ?? forms[0] ?? null
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const busy = Boolean(apps.pending)
  const guide = detail.data?.auth.guideUrl ?? detail.data?.website ?? null
  const missing = !form || form.fields.some(field => field.required && !field.defaultValue && !values[field.name]?.trim())

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!form || missing || busy) return
    const fields = Object.fromEntries(form.fields.flatMap(field => values[field.name]?.trim() ? [[field.name, values[field.name]]] : []))
    // Cleared as it is sent: a failed try is typed again, never left in the page.
    setValues({})
    setError('')
    void apps.connectWithKey(target.app, form.scheme, fields, target.replaceAccountId).then(result => {
      if (result === 'ok') {
        toast.success(target.replaceAccountId ? t('replaced', { name }) : t('connected', { name }))
        onClose()
      } else setError(result === 'incomplete' ? t('incomplete') : t('failed'))
    })
  }

  return <form className="flex flex-col gap-4" autoComplete="off" onSubmit={submit}>
    {detail.isLoading ? <div aria-hidden="true" className="flex flex-col gap-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-full" /></div>
      : !form ? <p role="alert" className="text-sm text-muted-foreground">{t('failed')}</p>
      : <FieldGroup>
        {forms.length > 1 && <Field>
          <FieldLabel htmlFor="credential-scheme">{t('scheme')}</FieldLabel>
          <NativeSelect id="credential-scheme" className="w-full" value={form.scheme} disabled={busy} onChange={event => { setScheme(event.target.value); setValues({}); setError('') }}>
            {forms.map(item => <NativeSelectOption key={item.scheme} value={item.scheme}>{t(`schemes.${item.scheme}`)}</NativeSelectOption>)}
          </NativeSelect>
        </Field>}
        {form.fields.map(field => <Field key={field.name}>
          <FieldLabel htmlFor={`credential-${field.name}`}>{field.label}</FieldLabel>
          <Input
            id={`credential-${field.name}`}
            name={field.name}
            type={field.secret ? 'password' : 'text'}
            autoComplete={field.secret ? 'new-password' : 'off'}
            autoCapitalize="off"
            spellCheck={false}
            required={field.required && !field.defaultValue}
            maxLength={4096}
            disabled={busy}
            placeholder={field.defaultValue ?? undefined}
            value={values[field.name] ?? ''}
            onChange={event => { const value = event.target.value; setValues(current => ({ ...current, [field.name]: value })); setError('') }}
            className="border-transparent bg-muted"
          />
          {field.description && <FieldDescription>{field.description}</FieldDescription>}
        </Field>)}
        {error && <FieldError role="alert" className="text-xs">{error}</FieldError>}
      </FieldGroup>}
    {guide && <a href={guide} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline">
      {t('where')}<ArrowUpRight data-icon="inline-end" aria-hidden="true" />
    </a>}
    <DialogFooter className="items-center sm:justify-between">
      <span className="flex items-center gap-1 text-xs text-muted-foreground"><LockIcon data-icon="inline-start" aria-hidden="true" />{t('securedBy')}<MikkaMarkSmall />Mikka</span>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{common('cancel')}</Button>
        <Button type="submit" disabled={busy || missing}>{busy ? common('saving') : t('submit')}</Button>
      </div>
    </DialogFooter>
  </form>
}
