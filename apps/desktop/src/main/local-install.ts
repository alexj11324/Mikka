import type { SshInstallState } from '@mikka/protocol/bridge'

/** Finder/login shells do not source nvm/fnm's interactive shell setup. */
export function nodeDiscoveryScript(minimum: number, home: string, systemBins = ['/opt/homebrew/opt/node@*/bin', '/usr/local/opt/node@*/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  return `case "$(uname -s)" in Linux|Darwin) ;; *) echo 'Linux or macOS required' >&2; exit 1;; esac
mikka_home=${quote(home)}
mikka_node=$(command -v node || true)
for mikka_bin in "\${mikka_node%/node}" "$mikka_home/.nvm/versions/node/"*/bin "$mikka_home/.local/share/fnm/node-versions/"*/installation/bin "$mikka_home/Library/Application Support/fnm/node-versions/"*/installation/bin "$mikka_home/.fnm/node-versions/"*/installation/bin "$mikka_home/.volta/tools/image/node/"*/bin "$mikka_home/.volta/bin" ${systemBins.join(' ')}; do
  [ -x "$mikka_bin/node" ] || continue
  if "$mikka_bin/node" -e 'process.exit(+process.versions.node.split(".")[0] >= ${minimum} ? 0 : 1)' 2>/dev/null; then
    printf 'MIKKA_NODE_BIN=%s\\n' "$mikka_bin"
    exit 0
  fi
done
echo 'Node.js >=${minimum} required' >&2
exit 1`
}

export class InstallProcessError extends Error {
  constructor(message: string, readonly stdout: string, readonly stderr: string, readonly exitCode: number | null, options?: ErrorOptions) {
    super(message, options)
    this.name = 'InstallProcessError'
  }
}

/** Installer diagnostics stay local; stdin credentials and common credential formats never do. */
export function redactInstallLog(value: string, input?: string) {
  let clean = input?.trim() ? value.replaceAll(input.trim(), '[REDACTED]') : value
  clean = clean.replace(/\b(?:orv_|npm_|ghp_|gho_|sk-)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:_authToken|password|access_token|refresh_token)[=:]\s*)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
  return clean
}

type Failure = NonNullable<SshInstallState['error']>
export function installFailure(error: unknown, step: SshInstallState['step']): Failure {
  const text = error instanceof InstallProcessError ? `${error.message}\n${error.stderr}` : error instanceof Error ? error.message : ''
  let cause: Failure['cause'] = step === 'service' ? 'service_failed' : step === 'connect' ? 'connection_failed' : 'command_failed'
  let remedy: Failure['remedy'] = step === 'service' ? 'retry_service' : step === 'connect' ? 'retry_connection' : 'view_log'
  if (/Node\.js >=\d+ required/.test(text)) { cause = 'node_required'; remedy = 'install_node_22' }
  else if (/Linux or macOS required/.test(text)) { cause = 'unsupported_os'; remedy = 'use_supported_os' }
  else if (/cancelled/.test(text)) { cause = 'cancelled'; remedy = 'retry' }
  else if (/timed out/.test(text)) { cause = 'timeout'; remedy = 'retry' }
  else if (/EACCES|EPERM|permission denied/i.test(text)) {
    cause = /_cacache|\.npm[/\\]|cache folder|npm-cache/.test(text) ? 'npm_cache_permission' : 'npm_permission'
    remedy = 'check_user_directory'
  }
  return { code: 'installer_failed', cause, remedy }
}

export const INSTALL_FAILURE_REASON: Record<Failure['cause'], string> = {
  node_required: 'Node.js >=22 required', unsupported_os: 'Linux or macOS required',
  npm_permission: 'Cannot write the Mikka install directory', npm_cache_permission: 'Cannot write the Mikka npm cache',
  cancelled: 'cancelled', timeout: 'Installation timed out', service_failed: 'Mikka service could not start',
  connection_failed: 'Device could not connect to the signed-in account', command_failed: 'Installation command failed',
}
