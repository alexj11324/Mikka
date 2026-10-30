import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const exec = promisify(execFile)
const label = 'com.aspectlylabs.mikka.daemon'
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const unitQuote = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`
export function serviceDefinition(input: { platform: string; node: string; entry: string; server: string; home: string; path: string; deviceType: string }) {
  const args = [input.node, input.entry, 'daemon', '--server', input.server]
  if (input.platform === 'linux') return `[Unit]\nDescription=Mikka daemon\nAfter=network-online.target\n\n[Service]\nExecStart=${args.map(unitQuote).join(' ')}\nRestart=on-failure\nRestartSec=5\nEnvironment=${unitQuote(`PATH=${input.path}`)}\nEnvironment=MIKKA_SERVICE=systemd\nEnvironment=MIKKA_DEVICE_TYPE=${input.deviceType === 'server' ? 'server' : 'laptop'}\n\n[Install]\nWantedBy=default.target\n`
  if (input.platform !== 'darwin') throw new Error('Services require Linux or macOS')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(input.path)}</string><key>MIKKA_SERVICE</key><string>launchd</string><key>MIKKA_DEVICE_TYPE</key><string>${input.deviceType === 'server' ? 'server' : 'laptop'}</string></dict><key>StandardErrorPath</key><string>${xml(join(input.home, 'Library/Logs/mikka-daemon.log'))}</string></dict></plist>\n`
}
export async function installService(server: string, deviceType = 'server') {
  const url = new URL(server)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid server URL')
  const home = homedir()
  const content = serviceDefinition({ platform: process.platform, node: process.execPath, entry: resolve(process.argv[1]), server, home, path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', deviceType })
  if (process.platform === 'linux') {
    const file = join(home, '.config/systemd/user/mikka-daemon.service')
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, content, { mode: 0o600 })
    // Permission varies by host. A denied linger request does not prevent the user service.
    await exec('loginctl', ['enable-linger'], { timeout: 10_000 }).catch(() => undefined)
    await exec('systemctl', ['--user', 'daemon-reload'])
    await exec('systemctl', ['--user', 'enable', 'mikka-daemon.service'])
    await exec('systemctl', ['--user', 'restart', 'mikka-daemon.service'])
  } else {
    const file = join(home, 'Library/LaunchAgents', `${label}.plist`)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await mkdir(join(home, 'Library/Logs'), { recursive: true })
    await writeFile(file, content, { mode: 0o600 })
    const domain = `gui/${process.getuid!()}`
    await exec('launchctl', ['bootout', `${domain}/${label}`]).catch(() => undefined)
    await exec('launchctl', ['bootstrap', domain, file])
  }
}

/** Let the service manager launch the replacement, preserving the same account/config. */
export async function restartService(update: boolean, beforeRestart: () => void, dependencies = {
  manager: process.env.MIKKA_SERVICE,
  update: async () => { await exec('npm', ['install', '--global', '@aspectlylabs/mikka'], { timeout: 300_000, maxBuffer: 1024 * 1024 }) },
  restart: () => { setImmediate(() => process.kill(process.pid, 'SIGUSR2')) },
}) {
  const manager = dependencies.manager
  if (manager !== 'systemd' && manager !== 'launchd') throw new Error('Daemon is not running as a managed service')
  if (update) await dependencies.update()
  // A failed exit triggers Restart=on-failure / KeepAlive.SuccessfulExit=false.
  // SIGUSR2 runs normal drain/cleanup first, then exits with failure for the manager.
  beforeRestart()
  dependencies.restart()
}
