'use client'

import { useId, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InlineLoadError } from '@/components/load-error'
import { withBasePath } from '@/lib/base-path'
import { useActionError } from '@/lib/use-action-error'
import { GroupHeader } from './group-header'

const MAX_ROLE_LENGTH = 2000
type PublicRole = { publicRole: string }

/** The owner endpoint projects public fields only; private instructions never reach this editor. */
async function requestPublicRole(botId: string, publicRole?: string): Promise<PublicRole> {
  const response = await fetch(withBasePath(`/api/bots/${botId}`), publicRole === undefined ? { cache: 'no-store' } : {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicRole }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'generic')
  if (body?.id !== botId || typeof body.publicRole !== 'string') throw new Error('generic')
  return { publicRole: body.publicRole }
}

/**
 * A bot's public role (what other people see it as), read and saved through the owner endpoint. The editor below
 * draws it; a UI layer's 概览 (the bot-overview slot) gets the same state.
 */
export function useBotPublicRole(botId: string, workspaceId?: string) {
  const t = useTranslations('Shell.panel.publicRole')
  const actionError = useActionError()
  const { data, error: loadError, mutate } = useSWR(['bot-public-role', workspaceId ?? null, botId], () => requestPublicRole(botId))
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const value = draft ?? data?.publicRole ?? ''
  const dirty = !!data && value !== data.publicRole

  async function save() {
    if (!data || !dirty || saving) return
    if (value.length > MAX_ROLE_LENGTH) return setError(t('tooLong', { max: MAX_ROLE_LENGTH }))
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await requestPublicRole(botId, value.trim())
      await mutate(next, { revalidate: false })
      setDraft(null)
      setSaved(true)
    } catch (failure) {
      setError(actionError(failure instanceof Error ? failure.message : null))
    } finally { setSaving(false) }
  }

  return {
    loaded: !!data, loadError: !!loadError, retry: () => { void mutate() }, value, max: MAX_ROLE_LENGTH, dirty, saving, saved, error,
    edit: (next: string) => { setDraft(next); setError(null); setSaved(false) },
    reset: () => { setDraft(null); setError(null); setSaved(false) },
    save,
  }
}

export function BotPublicRoleEditor({ botId, workspaceId }: { botId: string; workspaceId?: string }) {
  const t = useTranslations('Shell.panel.publicRole')
  const common = useTranslations('Common')
  const fieldId = useId(), hintId = useId(), statusId = useId()
  const role = useBotPublicRole(botId, workspaceId)
  const { value, dirty, saving, saved, error } = role

  function save(event: FormEvent) {
    event.preventDefault()
    void role.save()
  }

  return <section aria-label={t('label')} className="flex min-w-0 flex-col gap-2">
    <GroupHeader><FieldLabel htmlFor={fieldId}>{t('label')}</FieldLabel></GroupHeader>
    {role.loadError ? <InlineLoadError message={t('loadError')} retryLabel={common('retry')} onRetry={role.retry} />
      : !role.loaded ? <p role="status" className="px-2 text-xs text-muted-foreground">{common('loading')}</p>
      : <form onSubmit={save} className="flex min-w-0 flex-col gap-2">
        <FieldGroup><Field className="gap-2">
          <p id={hintId} className="px-2 text-xs text-muted-foreground">{t('hint')}</p>
          <Textarea id={fieldId} value={value} maxLength={MAX_ROLE_LENGTH} rows={4} disabled={saving}
            aria-describedby={`${hintId} ${statusId}`} aria-invalid={error ? true : undefined}
            placeholder={t('placeholder')} className="max-h-64 resize-y"
            onChange={event => role.edit(event.target.value)} />
        </Field></FieldGroup>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-2">
          <span className="text-xs tabular-nums text-muted-foreground">{t('count', { count: value.length, max: MAX_ROLE_LENGTH })}</span>
          <div className="flex items-center gap-2">
            {dirty && <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={role.reset}>{common('cancel')}</Button>}
            <Button type="submit" variant="secondary" size="sm" disabled={!dirty || saving}>{saving ? common('saving') : common('save')}</Button>
          </div>
        </div>
        <div id={statusId} aria-live="polite" className="px-2 text-xs">
          {error ? <p role="alert" className="text-destructive-foreground">{t('saveError')} {error}</p>
            : saved ? <p className="text-muted-foreground">{t('saved')}</p> : null}
        </div>
      </form>}
  </section>
}
