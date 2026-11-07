'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { getSubscriptionShare, updateSubscriptionShare } from '@/app/actions/personal-policy'
import { settingsKeys } from '@/lib/swr/keys'
import { useActionError } from '@/lib/use-action-error'

export type SubscriptionShareChange = { shared: boolean; allowOthers?: boolean }
type Change = SubscriptionShareChange

/**
 * 分享给团队成员 (components/settings/subscription-share-settings.tsx explains
 * the rule): the read and the save. `onSettled` runs after every save, so a
 * confirmation can close. The open-source page and the hosted layer draw it
 * each in their own look (docs/ui-overlay.md).
 */
export function useSubscriptionShare(workspaceId: string, onSettled?: () => void) {
  const actionError = useActionError()
  const share = useSWR(settingsKeys.subscriptionShare(workspaceId), () => getSubscriptionShare(workspaceId))
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<{ change: Change; message: string } | null>(null)
  const data = share.data && !share.data.error ? share.data : null

  async function change(next: Change) {
    setPending(true)
    setFailed(null)
    try {
      const result = await updateSubscriptionShare(next, workspaceId)
      if (result.error) { setFailed({ change: next, message: actionError(result.error) }); return }
      await share.mutate(result, { revalidate: false })
    } catch {
      setFailed({ change: next, message: actionError() })
    } finally {
      setPending(false)
      onSettled?.()
    }
  }

  const loadError = share.data?.error ? actionError(share.data.error) : null
  return { data, loadError, pending, failed, change }
}
