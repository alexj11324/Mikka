import { execFile } from 'node:child_process'
import { writeSync } from 'node:fs'
import { promisify } from 'node:util'
import { runServiceNpm } from './auto-update'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const exec = promisify(execFile)
const label = 'com.aspectlylabs.mikka.daemon'
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const unitQuote = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`
export function serviceDefinition(input: { platform: string; node: string; entry: string; server: string; home: string; path: string; deviceType: string; dataDir?: string; dev?: boolean; autoUpdate?: boolean }) {
  const args = [input.node, input.entry, 'daemon', '--server', input.server]
  if (input.dataDir) args.push('--data-dir', resolve(input.dataDir))
  if (input.dev) args.push('--dev')
  if (input.autoUpdate === false) args.push('--no-auto-update')
  if (input.platform === 'linux') return `[Unit]\nDescription=Mikka daemon\nAfter=network-online.target\n\n[Service]\nExecStart=${args.map(unitQuote).join(' ')}\nRestart=on-failure\nRestartSec=5\nEnvironment=${unitQuote(`PATH=${input.path}`)}\nEnvironment=MIKKA_SERVICE=systemd\nEnvironment=MIKKA_DEVICE_TYPE=${input.deviceType === 'server' ? 'server' : 'laptop'}\n\n[Install]\nWantedBy=default.target\n`
  if (input.platform !== 'darwin') throw new Error('Services require Linux or macOS')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(input.path)}</string><key>MIKKA_SERVICE</key><string>launchd</string><key>MIKKA_DEVICE_TYPE</key><string>${input.deviceType === 'server' ? 'server' : 'laptop'}</string></dict><key>StandardErrorPath</key><string>${xml(join(input.home, 'Library/Logs/mikka-daemon.log'))}</string></dict></plist>\n`
}
export async function installService(server: string, deviceType = 'server', options: { dataDir?: string; dev?: boolean; autoUpdate?: boolean } = {}) {
  const url = new URL(server)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid server URL')
  const home = homedir()
  const content = serviceDefinition({ platform: process.platform, node: process.execPath, entry: resolve(process.argv[1]), server, home, path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', deviceType, ...options })
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
    // Temporary #1512 diagnostic: only synchronous timestamps/error references
    // are recorded between the original commands; output happens after the sequence.
    const bootoutStartWall = Date.now(), bootoutStartMono = performance.now()
    let bootoutEndWall: number | null = null, bootoutEndMono: number | null = null
    let bootstrapStartWall: number | null = null, bootstrapStartMono: number | null = null
    let bootoutFailed = false, bootstrapFailed = false
    let bootoutError: unknown, bootstrapError: unknown
    try {
      await exec('launchctl', ['bootout', `${domain}/${label}`]).catch(error => { bootoutFailed = true; bootoutError = error })
      bootoutEndWall = Date.now(); bootoutEndMono = performance.now()
      bootstrapStartWall = Date.now(); bootstrapStartMono = performance.now()
      try { await exec('launchctl', ['bootstrap', domain, file]) }
      catch (error) { bootstrapFailed = true; bootstrapError = error; throw error }
    } finally {
      const endWall = Date.now(), endMono = performance.now()
      // Never emit paths, command arguments, output, messages or credentials.
      // A killed command process cannot emit a completed record.
      if (/^\/tmp\/mikka-i-[A-Za-z0-9]+$/.test(home)) try {
        const errors = new Set(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ENOBUFS'])
        const signals = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGABRT', 'SIGFPE', 'SIGKILL', 'SIGSEGV', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGUSR1', 'SIGUSR2'])
        const stage = (startWall: number | null, startMono: number | null, finishWall: number | null, finishMono: number | null, failed: boolean, error: unknown) => {
          const complete = startWall !== null && startMono !== null && finishWall !== null && finishMono !== null
          const value = error && typeof error === 'object' ? error as { code?: unknown; signal?: unknown } : undefined
          const exitCode = !complete ? null : !failed ? 0 : Number.isInteger(value?.code) && Number(value?.code) >= 0 && Number(value?.code) <= 255 ? Number(value?.code) : null
          return { startedAt: startWall === null ? null : new Date(startWall).toISOString(),
            finishedAt: finishWall === null ? null : new Date(finishWall).toISOString(),
            elapsedMs: complete ? Math.max(0, Math.round((finishMono! - startMono!) * 1000) / 1000) : null,
            complete, failed: complete ? failed : null, exitCode,
            errorCode: !complete || !failed ? null : typeof value?.code === 'number' ? null : typeof value?.code === 'string' && errors.has(value.code) ? value.code : 'OTHER',
            signal: typeof value?.signal === 'string' ? signals.has(value.signal) ? value.signal : 'OTHER' : null }
        }
        writeSync(1, 'MIKKA_LAUNCHCTL_DIAGNOSTIC ' + JSON.stringify({
          schema: 'issue1512.launchctl-inprocess.v1',
          bootout: stage(bootoutStartWall, bootoutStartMono, bootoutEndWall, bootoutEndMono, bootoutFailed, bootoutError),
          bootstrap: stage(bootstrapStartWall, bootstrapStartMono, bootstrapStartWall === null ? null : endWall, bootstrapStartMono === null ? null : endMono, bootstrapFailed, bootstrapError),
          betweenCommandsMs: bootoutEndMono !== null && bootstrapStartMono !== null ? Math.max(0, Math.round((bootstrapStartMono - bootoutEndMono) * 1000) / 1000) : null,
        }) + '\n')
      } catch { /* Diagnostic output must never replace the original command result. */ }
    }
  }
}

/** Let the service manager launch the replacement, preserving the same account/config. */
export async function restartService(update: boolean, beforeRestart: () => void, dependencies = {
  manager: process.env.MIKKA_SERVICE,
  update: async () => { await runServiceNpm(['install', '--global', '--engine-strict', '@aspectlylabs/mikka']) },
  restart: () => { setImmediate(() => { if (canRestart()) process.kill(process.pid, 'SIGUSR2') }) },
}, canRestart = () => true) {
  const manager = dependencies.manager
  if (manager !== 'systemd' && manager !== 'launchd') throw new Error('Daemon is not running as a managed service')
  if (update) await dependencies.update()
  // A failed exit triggers Restart=on-failure / KeepAlive.SuccessfulExit=false.
  // SIGUSR2 runs normal drain/cleanup first, then exits with failure for the manager.
  if (!canRestart()) return
  beforeRestart()
  dependencies.restart()
}

/** Remove only our service definition; npm, repositories and worktrees stay. */
export async function uninstallService(clearCredential: () => void, dependencies = {
  manager: process.env.MIKKA_SERVICE,
  home: homedir(),
  uid: process.getuid?.() ?? 0,
  run: async (program: string, args: string[]) => { await exec(program, args, { timeout: 10_000 }) },
  exit: (): void => { process.exit(0) },
}) {
  try {
    if (dependencies.manager === 'systemd') {
      await dependencies.run('systemctl', ['--user', 'disable', 'mikka-daemon.service'])
      await rm(join(dependencies.home, '.config/systemd/user/mikka-daemon.service'), { force: true })
      await dependencies.run('systemctl', ['--user', 'daemon-reload'])
    } else if (dependencies.manager === 'launchd') {
      await rm(join(dependencies.home, 'Library/LaunchAgents', `${label}.plist`), { force: true })
    }
  } finally {
    // bootout can terminate this process, so forget credentials first.
    clearCredential()
    try {
      if (dependencies.manager === 'launchd') await dependencies.run('launchctl', ['bootout', `gui/${dependencies.uid}/${label}`])
    } finally { dependencies.exit() }
  }
}
