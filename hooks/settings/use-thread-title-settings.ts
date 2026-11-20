'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { saveThreadTitleSettings, type ThreadTitleSettingsView } from '@/app/actions/thread-title-settings'
import type { ThreadTitleTriggers } from '@/lib/thread-title'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'

type Read = ThreadTitleSettingsView | { error: string }

/**
 * Capy's "Thread titles" for one scope: the person's own (on top of the workspace's) or the workspace's (admins).
 * Instructions save when the field is left, as Capy's; the trigger saves when it is chosen.
 */
export function useThreadTitleSettings(scope: 'mine' | 'workspace', workspaceId: string | null = null) {
  const t = useTranslations('Settings.threadTitles')
  const key = settingsKeys.threadTitles(workspaceId)
  const read = useSWR(key, () => settingsRead<Read>('thread-titles', { workspace: workspaceId }))
  const view = read.data && !('error' in read.data) ? read.data : null
  const stored = view ? (scope === 'mine' ? view.mine : view.workspace) : null
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null)
  const canEdit = Boolean(view) && (scope === 'mine' || view!.admin)

  async function save(change: { instructions?: string; triggers?: ThreadTitleTriggers | null }, failed: string, saved?: string) {
    setBusy(true); setMessage(null)
    try {
      const result = await saveThreadTitleSettings({ scope, workspaceId: workspaceId ?? undefined, ...change })
      if ('error' in result && result.error) { setMessage({ kind: 'error', text: failed }); return }
      await read.mutate(result as ThreadTitleSettingsView, { revalidate: false })
      setDraft(null)
      if (saved) setMessage({ kind: 'saved', text: saved })
    } catch { setMessage({ kind: 'error', text: failed }) }
    finally { setBusy(false) }
  }

  const instructions = draft ?? stored?.instructions ?? ''
  return {
    loaded: Boolean(view),
    loadFailed: Boolean(read.error || (read.data && 'error' in read.data)),
    reload: () => { void read.mutate() },
    canEdit, busy, message,
    instructions,
    type: (value: string) => setDraft(value),
    /** On leaving the field: saves when it changed, saying 已保存 or 已清除 as Capy does. */
    commit: (next?: string) => {
      const value = next ?? draft
      if (!stored || busy || value === null || value.trim() === stored.instructions) { setDraft(null); return }
      setDraft(value)
      void save({ instructions: value }, t('saveError'), value.trim() ? t('saved') : t('cleared'))
    },
    /** The member's own choice, or null for the workspace's (Capy's "Org default"); the workspace always has one. */
    triggers: stored?.triggers ?? null,
    workspaceTriggers: view?.workspace.triggers ?? null,
    setTriggers: (value: ThreadTitleTriggers | null) => { void save({ triggers: value }, t('triggersError')) },
  }
}
