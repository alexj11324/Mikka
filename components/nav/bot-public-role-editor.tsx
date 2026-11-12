'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { withBasePath } from '@/lib/base-path'
import { useActionError } from '@/lib/use-action-error'

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
 * Bot Overview reads and saves the owner's public role through the owner endpoint.
 */
export function useBotPublicRole(botId: string, workspaceId: string | undefined, visible: boolean) {
  const t = useTranslations('Shell.panel.publicRole')
  const actionError = useActionError()
  const { data, error: loadError, mutate } = useSWR(visible ? ['bot-public-role', workspaceId ?? null, botId] : null, () => requestPublicRole(botId))
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
