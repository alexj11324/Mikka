import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tsImport } from 'tsx/esm/api'

const unavailable = reason => ({ source: 'local_daemon_hello', status: 'unavailable', reason })
function metadata(hello, status = 'connected') {
  if (!hello || typeof hello.daemonVersion !== 'string' || hello.daemonVersion.length > 100
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(hello.daemonVersion)
    || !Number.isSafeInteger(hello.protocolVersion) || hello.protocolVersion < 0) return unavailable('invalid_hello')
  return { source: 'local_daemon_hello', status, daemonVersion: hello.daemonVersion, protocolVersion: hello.protocolVersion }
}

/** Diagnostic only. Read the actual installed daemon's authenticated hello in
 * an exact harness-owned profile. Never report this checkout's package version
 * as the installed version, expose its secret/PID/settings, or drain a service.
 * The caller records this outside the measured cold/idle interval. */
export async function readNativeDaemonMetadata(profile) {
  if (typeof profile !== 'string' || !isAbsolute(profile)) throw new Error('NATIVE_METADATA_REQUIRES_EXACT_PROFILE')
  let client, timer, expired = false
  let isProtocolMismatch
  try {
    const directory = await realpath(profile)
    const [socket, secret] = await Promise.all([lstat(join(directory, 'daemon.sock')), lstat(join(directory, 'daemon.secret'))])
    if (!socket.isSocket() || !secret.isFile() || secret.size > 1024) return unavailable('invalid_profile')
    const module = await tsImport('@mikka/daemon/client', import.meta.url)
    isProtocolMismatch = module.isProtocolMismatch
    const connecting = module.connectDaemonInDataDir(directory, { name: 'mikka-native-acceptance-metadata', version: '1' }, { timeoutMs: 2000, drainOnMismatch: false })
      .then(value => { if (expired) value.close(); return value })
    client = await Promise.race([connecting, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(Object.assign(new Error('NATIVE_METADATA_TIMEOUT'), { code: 'ETIMEDOUT' })) }, 3000)
    })])
    return metadata(client.hello)
  } catch (error) {
    // The production server checks the secret before returning mismatch data.
    if (isProtocolMismatch?.(error)) return metadata(error.data, 'protocol_mismatch')
    if (error.code === 'ENOENT') return unavailable('socket_or_profile_missing')
    if (error.code === 'ECONNREFUSED') return unavailable('socket_refused')
    if (error.code === 'ETIMEDOUT') return unavailable('handshake_timeout')
    return unavailable('handshake_failed')
  } finally { expired = true; clearTimeout(timer); client?.close() }
}
