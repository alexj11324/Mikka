'use client'

import { useSyncExternalStore } from 'react'
import { currentUiPreferences, DEFAULT_UI, subscribeUiPreferences } from '@/lib/ui-preferences'

/** The last published preferences. The server snapshot is the default, so the first paint is not an empty list. */
export function useUiPreferenceSnapshot() {
  return useSyncExternalStore(subscribeUiPreferences, currentUiPreferences, () => DEFAULT_UI)
}
