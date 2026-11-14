// Reads the daemon on this computer over its local socket. The daemon owns
// the device credential; this module only reports what the UI may know.

import { connectDaemonInDataDir } from '@mikka/daemon/client'
import { defaultDataDir } from '@mikka/daemon/paths'
import type { LocalDevice } from '@mikka/protocol/bridge'
import type { ComputerDoctor } from '@mikka/protocol/computer'
import type { QuotaSnapshotReport } from '@mikka/protocol/quota'
import { unknownQuotaReport } from '@mikka/protocol/quota'

import { OFFLINE_DEVICE, toLocalDevice } from './daemon-map'

const CLIENT = { name: 'mikka-desktop', version: __MIKKA_APP_VERSION__ }
const FLAVOR = __MIKKA_FLAVOR__

function dataDir(): string {
  return defaultDataDir(FLAVOR)
}

export async function localDeviceStatus(): Promise<LocalDevice> {
  try {
    const client = await connectDaemonInDataDir(dataDir(), CLIENT)
    try {
      return toLocalDevice(await client.request('daemon.status'))
    } finally {
      client.close()
    }
  } catch {
    return OFFLINE_DEVICE
  }
}

export async function localQuota(): Promise<QuotaSnapshotReport> {
  try {
    const client = await connectDaemonInDataDir(dataDir(), CLIENT)
    try {
      return await client.request('quota.snapshot')
    } finally {
      client.close()
    }
  } catch {
    return unknownQuotaReport()
  }
}

/**
 * Local computer use on this Mac, as the daemon can see it. Null means no
 * daemon, or a daemon older than the RPC: the page then hides the section.
 * The grant is the person's click only; it opens macOS permission dialogs.
 */
export async function localComputerPermissions(): Promise<ComputerDoctor | null> {
  try {
    const client = await connectDaemonInDataDir(dataDir(), CLIENT)
    try {
      return await client.request('computer.permissions')
    } finally {
      client.close()
    }
  } catch {
    return null
  }
}

export async function grantLocalComputerPermissions(): Promise<ComputerDoctor | null> {
  try {
    const client = await connectDaemonInDataDir(dataDir(), CLIENT)
    try {
      return await client.request('computer.permissions.grant')
    } finally {
      client.close()
    }
  } catch {
    return null
  }
}
