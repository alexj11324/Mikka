'use client'

import { useLayoutEffect, useSyncExternalStore } from 'react'
import useSWR from 'swr'
import { useTheme } from 'next-themes'
import { updatePreferences } from '@/app/actions/preferences'
import { DEFAULT_UI, currentUiPreferences, publishUiPreferences, subscribeUiPreferences, type UiPreferences, type UiPreferencesPatch } from '@/lib/ui-preferences'
import { settingsRead } from '@/lib/settings-read'
import { ReadResponseError } from '@/lib/swr/retry'
import { settingsKeys } from '@/lib/swr/keys'

type Read = { ui?: UiPreferences; error?: string }

/** The signed-in person's interface preferences, saved through the existing preferences action. */
export function useUiPreferences() {
  const read = useSWR(settingsKeys.preferences(), () => settingsRead<Read>('preferences'))
  const { setTheme } = useTheme()
  const ui = read.data && !read.data.error && read.data.ui ? read.data.ui : DEFAULT_UI
  useLayoutEffect(() => {
    if (read.data && !read.data.error && read.data.ui) publishUiPreferences(read.data.ui)
  }, [read.data])
  useLayoutEffect(() => {
    if (!read.data?.ui?.appearanceSync) return
    setTheme(read.data.ui.colorScheme)
  }, [read.data?.ui?.appearanceSync, read.data?.ui?.colorScheme, setTheme])
  async function save(patch: UiPreferencesPatch) {
    const result = await updatePreferences({ ui: patch })
    if ('error' in result && result.error) throw new Error(result.error)
    await read.mutate()
    return result
  }
  const denied = read.error instanceof ReadResponseError && read.error.status === 403
  return { ui, loading: read.isLoading && !read.data, failed: Boolean(read.error || read.data?.error) && !denied, denied, reload: () => { void read.mutate() }, save }
}

/** The last published preferences. Changes re-render; the server snapshot is the default so the first paint is not an empty list. */
export function useUiPreferenceSnapshot() {
  return useSyncExternalStore(subscribeUiPreferences, currentUiPreferences, () => DEFAULT_UI)
}
