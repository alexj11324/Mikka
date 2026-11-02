'use client'

import { useState } from 'react'
import { useSWRConfig } from 'swr'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { SubscriptionSettings } from '@/components/settings/subscription-settings'
import { botModelMenuKey } from '@/components/coordinator/bot-model-picker'

/**
 * 绑定订阅 where the person is (decision 2026-11-02-1450, 「同一页完成」): the
 * same Claude / ChatGPT sign-in as 模型与订阅, in a dialog on the chat. Closing
 * it reads the model menu again, so a new subscription shows at once.
 */
export function ConnectSubscriptionButton({ workspaceId, botId, label, variant = 'default' }: { workspaceId: string; botId: string | null; label: string; variant?: 'default' | 'outline' }) {
  const [open, setOpen] = useState(false)
  const { mutate } = useSWRConfig()
  return <>
    <Button type="button" size="sm" variant={variant} onClick={() => setOpen(true)}>{label}</Button>
    <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) void mutate(botModelMenuKey(botId)) }}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogTitle>{label}</DialogTitle>
        <SubscriptionSettings workspaceId={workspaceId} />
      </DialogContent>
    </Dialog>
  </>
}
