import { localDeviceAccount, type LocalDeviceAccount } from '@mikka/protocol/bridge'
import type { SshInstaller } from './ssh-install'

/** Uses the desktop's cookie partition; redirects and cached account reads
 * cannot transfer setup authority to another page or an earlier login. */
export async function readLocalDeviceAccount(fetcher: (url: string, init: RequestInit) => Promise<Response>, appUrl: string): Promise<LocalDeviceAccount> {
  const response = await fetcher(`${appUrl.replace(/\/$/, '')}/api/devices/enrollment`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error('Sign in to register a device')
  return localDeviceAccount.parse(await response.json())
}

/** Setup admission consumes only the fresh owner, never a device-list snapshot. */
export async function readLocalDeviceOwner(fetcher: (url: string, init: RequestInit) => Promise<Response>, appUrl: string): Promise<Pick<LocalDeviceAccount, 'ownerId'>> {
  const response = await fetcher(`${appUrl.replace(/\/$/, '')}/api/devices/enrollment?view=owner`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error('Sign in to register a device')
  return localDeviceAccount.pick({ ownerId: true }).parse(await response.json())
}

/** Main owns the account key. A workspace change is the same account; A→B→A
 * is three setup contexts, even while the Electron process stays alive. */
export function localSetupController(installer: Pick<SshInstaller, 'state' | 'cancel' | 'beginLocal' | 'repairLocal' | 'restartLocal'>, account: () => Promise<Pick<LocalDeviceAccount, 'ownerId'>>) {
  let autoOwner: string | null = null
  let pending = Promise.resolve()
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const result = pending.then(action)
    pending = result.then(() => undefined, () => undefined)
    return result
  }
  const start = async (action: 'install' | 'repair' | 'restart', automatic: boolean) => {
    const current = await account()
    if (automatic && autoOwner === current.ownerId) return installer.state()
    const active = installer.state()
    if (autoOwner && autoOwner !== current.ownerId && active && (active.status === 'running' || active.status === 'fingerprint')) await installer.cancel(active.id)
    autoOwner = current.ownerId
    try {
      return action === 'repair' ? await installer.repairLocal(current.ownerId) : action === 'restart' ? await installer.restartLocal(current.ownerId) : await installer.beginLocal(current.ownerId)
    } catch (error) { autoOwner = null; throw error }
  }
  return {
    automatic: (action: 'install' | 'repair') => run(() => start(action, true)),
    install: () => run(() => start('install', false)),
    restart: () => run(() => start('restart', false)),
  }
}
