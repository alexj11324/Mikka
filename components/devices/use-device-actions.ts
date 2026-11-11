'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { removeDevice, renameDevice, sendDeviceCommand, setDeviceEnabled, type DeviceView } from '@/app/actions/agents'
import type { ActionResult } from '@/lib/action-result'
import { useActionError } from '@/lib/use-action-error'

/** Commands for a device that this account connected, shared by Settings' row presentations. */
export function useDeviceActions(device: Pick<DeviceView, 'id' | 'name' | 'online'>, onChanged: () => void) {
  const t = useTranslations('Devices')
  const translateError = useActionError()
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)

  async function run<T extends object>(action: () => Promise<ActionResult<T>>, onSuccess?: (result: T) => void) {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    try {
      const result = await action()
      if (result.error !== undefined) {
        toast.error(translateError(result.error))
        return false
      }
      onSuccess?.(result)
      onChanged()
      return true
    } catch {
      toast.error(translateError('deviceSaveFailed'))
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return {
    busy,
    rename: (name: string) => run(() => renameDevice(device.id, name.trim())),
    setEnabled: (enabled: boolean) => run(() => setDeviceEnabled({ deviceId: device.id, enabled })),
    command: (kind: 'restart' | 'update' | 'redetect') => run(() => sendDeviceCommand({ deviceId: device.id, kind }), () => {
      toast.success(device.online ? t(`commands.sent.${kind}`, { name: device.name }) : t('commands.queued', { name: device.name }))
    }),
    remove: () => run(() => removeDevice(device.id), result => {
      if (result.uninstall === 'queued') toast.success(t('remove.uninstalling', { name: device.name }))
    }),
  }
}
