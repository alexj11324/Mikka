'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { pollDevices, type DeviceView } from '@/app/actions/agents'
import { useLiveKey } from '@/hooks/use-live-key'
import { listReadDeadline, listReadPresence, observeListRead, ownerListWorkspace, UNRESOLVED_LIST_SCOPE } from '@/lib/live/list-read'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { DevicesPage } from '@ui-slot/settings-devices'
import { ConnectDeviceDialog } from './connect-device-dialog'
import { SshAddDialog } from './ssh-add-dialog'
import { LocalSetupStatus } from './local-setup-status'

/**
 * 设置 › 设备 (Figma V09b 683:24269, S-L2 684:24422, S-L3 684:24731): only
 * machines the user connected, laptops under 电脑 and SSH-installed servers
 * under Remote control. The bots' cloud computer is ours and never listed.
 * In the desktop app this computer becomes a device by itself, shown here by
 * LocalSetupStatus; 添加设备 is the one-click SSH install for remote computers
 * with 手动连接 last (V09c), and the web shows the three commands (V09d), where
 * the browser cannot open SSH (#491). In the desktop app, 重新连接 on this
 * computer's own row restarts its daemon (usability C10).
 */
export function DevicesSettings(_props: { workspaceId?: string }) {
  const key = 'devices-settings'
  const { data, error, mutate } = useSWR(key, () => observeListRead(pollDevices))
  const devices = error ? undefined : data?.devices
  // The same home socket watches gateway presence; only an acknowledged watch
  // replaces fallback. Old Workers, unavailable proofs and disconnects keep it.
  const owner = data?.live.ownerId
  const home = owner ? ownerListWorkspace(data, owner) : null
  useLiveKey('device_list', home ?? UNRESOLVED_LIST_SCOPE, [key], home, { minIntervalMs: 2_000, deadline: owner ? listReadDeadline(data, owner) : undefined, presence: listReadPresence(data), shareAcrossTabs: true })
  const [adding, setAdding] = useState(false)
  const [desktopSsh, setDesktopSsh] = useState(false)
  const [thisDevice, setThisDevice] = useState<string | null>(null)
  useEffect(() => {
    const bridge = bridgeFromWindow(window as MikkaWindow)
    setDesktopSsh(Boolean(bridge?.ssh))
    void bridge?.device?.status().then(status => setThisDevice(status.deviceId), () => {})
  }, [])
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !event.shiftKey && !event.altKey) { event.preventDefault(); setAdding(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const changed = () => { void mutate() }
  // 重新连接: this computer restarts its own daemon; another device opens 添加设备 on the desktop,
  // and on the web only the command that starts its client again (review C11).
  const [reconnecting, setReconnecting] = useState(false)
  const reconnect = (device: DeviceView) => {
    const ssh = bridgeFromWindow(window as MikkaWindow)?.ssh
    if (!ssh) return setReconnecting(true)
    if (device.id === thisDevice && ssh.restartLocal) void ssh.restartLocal().catch(() => {})
    setAdding(true)
  }
  return <>
    <DevicesPage devices={devices} listError={Boolean(error)} onAdd={() => setAdding(true)} onChanged={changed} onReconnect={reconnect}
      localSetup={desktopSsh ? <LocalSetupStatus onOnline={changed} /> : null} />
    {desktopSsh
      ? <SshAddDialog open={adding} onOpenChange={setAdding} devices={devices ?? []} onAdded={changed} />
      : <ConnectDeviceDialog open={adding} onOpenChange={setAdding} hideTrigger />}
    {!desktopSsh && <ConnectDeviceDialog open={reconnecting} onOpenChange={setReconnecting} hideTrigger reconnect />}
  </>
}
