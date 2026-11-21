'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import useSWR, { unstable_serialize } from 'swr'
import { Laptop, Server } from 'lucide-react'
import { listDevices } from '@/app/actions/agents'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field'
import { useLiveKey } from '@/hooks/use-live-key'
import { withBasePath } from '@/lib/base-path'
import { bridgeFromWindow } from '@/lib/platform/detect'
import { useDesktopCapability } from '@/lib/platform/use-platform'
import type { DeviceCheckout } from '@/lib/project-resources/device-checkouts'
import { fetchSettingsData, settingsReadOptions } from '@/lib/settings-data'

export function ProjectDeviceCheckouts({ readerId, workspaceId, projectId }: { readerId: string; workspaceId: string; projectId: string }) {
  const t = useTranslations('Projects.deviceCheckouts'), common = useTranslations('Common')
  const native = useDesktopCapability('device.pickRepo')
  const [open, setOpen] = useState(false), [opening, setOpening] = useState(0)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lifetime = useRef(0)
  useEffect(() => { lifetime.current++; return () => { lifetime.current++ } }, [])
  const base = '/api/workspaces/' + workspaceId
  const key = open ? ['project-device-checkouts', readerId, workspaceId, projectId, opening] : null
  const query = useSWR(key, async () => {
    const checkouts = await fetchSettingsData<DeviceCheckout[]>(base + '/projects/' + projectId + '/device-checkouts')
    const bridge = native ? bridgeFromWindow(window) : null
    const [local, devices] = await Promise.all([bridge?.device.status(), checkouts.length || bridge ? listDevices() : []])
    return { checkouts, devices, localId: local?.signedIn && local.workspaceId === workspaceId && devices.some(device => device.id === local.deviceId) ? local.deviceId : null }
  }, { ...settingsReadOptions, revalidateOnMount: true, dedupingInterval: 0 })
  useLiveKey('device_list', open ? workspaceId : null, [unstable_serialize(key)], workspaceId)
  const data = query.error || query.isValidating ? undefined : query.data

  async function update(deviceId: string, root?: string) {
    const response = await fetch(withBasePath(base + '/devices/' + deviceId + '/project-checkout' + (root === undefined ? '/clear' : '')), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, root }), cache: 'no-store',
    })
    if (!response.ok) throw new Error('projectDeviceCheckout')
  }

  async function edit(clearId?: string) {
    if (busy || !data) return
    const started = lifetime.current
    setBusy(true); setError('')
    try {
      if (clearId) await update(clearId)
      else {
        const device = bridgeFromWindow(window)?.device
        if (!device) return
        if (!data.localId) {
          const linked = await device.link(workspaceId)
          if (!linked.signedIn || linked.workspaceId !== workspaceId || !linked.deviceId) setError(t('linkFailed'))
        } else {
          const picked = await device.pickRepo()
          if (started !== lifetime.current || picked.status === 'cancelled') return
          if (picked.status !== 'picked') { setError(t('notRepo')); return }
          const current = await device.status()
          if (started !== lifetime.current) return
          if (!current.signedIn || current.workspaceId !== workspaceId || current.deviceId !== data.localId) {
            setError(t('linkFailed'))
          } else await update(data.localId, picked.repo.path)
        }
      }
      await query.mutate()
    } catch {
      if (started === lifetime.current) setError(t('writeFailed'))
      await query.mutate().catch(() => undefined)
    } finally {
      if (started === lifetime.current) setBusy(false)
    }
  }

  return <><Button variant="outline" size="sm" onClick={() => { setError(''); setOpening(value => value + 1); setOpen(true) }}>{t('title')}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value) }}>
      <DialogContent><DialogHeader><DialogTitle>{t('title')}</DialogTitle></DialogHeader>
        {query.error ? <FieldError>{t('readFailed')} <Button variant="link" onClick={() => void query.mutate()}>{common('retry')}</Button></FieldError>
          : !data ? <p role="status">{common('loading')}</p>
          : <div className="grid max-h-[55vh] gap-2 overflow-y-auto">
              {data.checkouts.map(item => {
                const device = data.devices.find(value => value.id === item.deviceId)
                const Icon = device?.deviceType === 'server' ? Server : Laptop
                return <div key={item.deviceId} className="flex min-w-0 items-center justify-between gap-2">
                  <div className="min-w-0"><span className="flex items-center gap-2"><Icon aria-hidden="true" className="size-4" />{device?.name ?? t('device')}</span><span className="break-all text-sm text-muted-foreground">{item.root}</span></div>
                  <Button variant="ghost" size="sm" disabled={busy} aria-label={t('clearFor', { device: device?.name ?? t('device') })} onClick={() => void edit(item.deviceId)}>{common('remove')}</Button>
                </div>
              })}
              {!data.checkouts.length && <p>{native ? t('empty') : t('desktopEmpty')}</p>}
            </div>}
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{common('close')}</Button>
          {native && data && <Button disabled={busy} onClick={() => void edit()}>{data.localId ? t('choose') : t('link')}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog></>
}
