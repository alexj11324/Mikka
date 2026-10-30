'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { getPreferences, updatePreferences } from '@/app/actions/preferences'
import type { ActionErrorCode } from '@/lib/action-result'
import type { Preferences } from '@/lib/preferences'

export type PreferencesPatch = Partial<Omit<Preferences, 'memoryEnabled'>> & { memoryEnabled?: boolean }

/** A preference save that was refused, kept so 重试 sends exactly the same change again. */
export interface FailedSave { patch: PreferencesPatch; code: ActionErrorCode | null }

/**
 * The person's preferences with optimistic saves. A save the server refuses
 * (`{ error }`) or that never arrives rolls the value back (S-O) and is kept in
 * `failed` so the page can show why and retry it.
 */
export function usePreferences() {
  const swr = useSWR('preferences', getPreferences)
  const [failed, setFailed] = useState<FailedSave | null>(null)

  async function save(patch: PreferencesPatch): Promise<boolean> {
    const shown = swr.data
    if (!shown) return false
    setFailed(null)
    try {
      await swr.mutate(async current => {
        const result = await updatePreferences(patch)
        if (result.error) throw Object.assign(new Error(result.error), { code: result.error })
        return { ...(current ?? shown), ...result }
      }, { optimisticData: { ...shown, ...patch }, rollbackOnError: true, revalidate: false })
      return true
    } catch (error) {
      setFailed({ patch, code: (error as { code?: ActionErrorCode }).code ?? null })
      return false
    }
  }

  return { ...swr, save, failed, retry: () => failed ? save(failed.patch) : Promise.resolve(false) }
}
