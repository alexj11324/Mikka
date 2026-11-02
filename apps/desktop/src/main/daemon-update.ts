// After the app starts (and so after every desktop update), the daemon on this
// computer is asked to update itself. The daemon owns the update: it checks the
// release, waits until no run is active, installs through its own service npm
// and reports a failure in Settings › Devices (updateFailure). The app never
// installs anything and only reaches its own flavor's data dir.

import { connectDaemonInDataDir, isNoDaemon, ResponseError } from '@mikka/daemon/client'
import { defaultDataDir } from '@mikka/daemon/paths'
import type { Flavor } from '@mikka/protocol/bridge'
import type { DaemonRpcResult } from '@mikka/protocol/daemon'

type UpdateState = DaemonRpcResult<'daemon.update'>['state']
/** `absent`: no daemon here. `unsupported`: an older daemon, which still updates on its hourly check. */
export type LocalDaemonUpdate = UpdateState | 'absent' | 'unsupported' | 'failed'

export type DaemonUpdateConnect = (dataDir: string) => Promise<{
  request(method: 'daemon.update'): Promise<DaemonRpcResult<'daemon.update'>>
  close(): void
}>

const METHOD_NOT_FOUND = -32601

export async function updateLocalDaemon(flavor: Flavor, options: {
  connect: DaemonUpdateConnect
  env?: NodeJS.ProcessEnv
}): Promise<LocalDaemonUpdate> {
  let client: Awaited<ReturnType<DaemonUpdateConnect>>
  try {
    client = await options.connect(defaultDataDir(flavor, options.env))
  } catch (error) {
    return isNoDaemon(error) ? 'absent' : 'failed'
  }
  try {
    return (await client.request('daemon.update')).state
  } catch (error) {
    return error instanceof ResponseError && error.code === METHOD_NOT_FOUND ? 'unsupported' : 'failed'
  } finally {
    client.close()
  }
}

export function connectForUpdate(client: { name: string; version: string }): DaemonUpdateConnect {
  return dataDir => connectDaemonInDataDir(dataDir, client)
}
