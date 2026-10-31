import { describe, expect, it } from 'vitest'
import { serviceDefinition, restartService, uninstallService } from '../src/service'
import { mkdtemp, mkdir, writeFile, access, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const input = { platform: 'linux', node: '/usr/local/bin/node', entry: '/opt/mikka/mikka.js', server: 'https://example.com/mikka', home: '/home/mikka', path: '/usr/local/bin:/usr/bin', deviceType: 'server' }
describe('managed daemon service', () => {
  it('starts the installed CLI using Node, with persistent restart and server type', () => {
    const unit = serviceDefinition(input)
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/mikka/mikka.js" "daemon" "--server" "https://example.com/mikka"')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('MIKKA_DEVICE_TYPE=server')
    expect(unit).not.toContain('credential')
  })
  it('escapes systemd specifiers and XML instead of interpreting paths or URLs', () => {
    expect(serviceDefinition({ ...input, entry: '/a%/b$".js' })).toContain('/a%%/b$$\\".js')
    const plist = serviceDefinition({ ...input, platform: 'darwin', entry: '/a&b/<mikka>.js' })
    expect(plist).toContain('/a&amp;b/&lt;mikka&gt;.js')
    expect(plist).toContain('<key>SuccessfulExit</key><false/>')
    expect(plist).toContain('<string>launchd</string>')
  })
  it.each(['linux', 'darwin'])('persists data directory, development mode and automatic update opt-out on %s', platform => {
    const definition = serviceDefinition({ ...input, platform, dataDir: '/data/Mikka & Dev', dev: true, autoUpdate: false })
    expect(definition).toContain('--data-dir')
    expect(definition).toContain(platform === 'darwin' ? '/data/Mikka &amp; Dev' : '/data/Mikka & Dev')
    expect(definition).toContain('--dev')
    expect(definition).toContain('--no-auto-update')
  })
  it('resolves relative data directories before persisting the service arguments', () => {
    expect(serviceDefinition({ ...input, dataDir: './existing-state' })).toContain(resolve('./existing-state'))
  })
  it('refuses unsupported platforms', () => {
    expect(() => serviceDefinition({ ...input, platform: 'win32' })).toThrow('Linux or macOS')
  })
})

it('updates first, persists the command receipt, then requests one service restart', async () => {
  const events: string[] = []
  await restartService(true, () => { events.push('receipt') }, {
    manager: 'systemd', update: async () => { events.push('update') }, restart: () => { events.push('restart') },
  })
  expect(events).toEqual(['update', 'receipt', 'restart'])
  events.length = 0
  await expect(restartService(true, () => { events.push('receipt') }, {
    manager: 'launchd', update: async () => { throw new Error('npm failed') }, restart: () => { events.push('restart') },
  })).rejects.toThrow('npm failed')
  expect(events).toEqual([])
  await expect(restartService(false, () => {}, { manager: undefined, update: async () => {}, restart: () => {} })).rejects.toThrow('managed service')
})

it.each([
  ['linux', 'systemd', '.config/systemd/user/mikka-daemon.service'],
  ['darwin', 'launchd', 'Library/LaunchAgents/com.aspectlylabs.mikka.daemon.plist'],
])('uninstalls %s service, deletes credentials before unloading and exits without touching work', async (platform, manager, file) => {
  const home = await mkdtemp(join(tmpdir(), 'mikka-uninstall-'))
  const events: string[] = []
  try {
    await mkdir(dirname(join(home, file)), { recursive: true })
    await writeFile(join(home, file), 'fixture service')
    await writeFile(join(home, 'repository'), 'keep repository')
    await uninstallService(() => { events.push('credential') }, {
      manager, home, uid: 501,
      run: async (program, args) => { events.push(`${program} ${args.join(' ')}`) },
      exit: () => { events.push('exit') },
    })
    await expect(access(join(home, file))).rejects.toThrow()
    expect(await readFile(join(home, 'repository'), 'utf8')).toBe('keep repository')
    expect(events.at(-1)).toBe('exit')
    if (manager === 'systemd') expect(events).toEqual(['systemctl --user disable mikka-daemon.service', 'systemctl --user daemon-reload', 'credential', 'exit'])
    else expect(events).toEqual(['credential', 'launchctl bootout gui/501/com.aspectlylabs.mikka.daemon', 'exit'])
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('a foreground daemon clears its credentials without removing another managed service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mikka-foreground-uninstall-'))
  const file = join(home, '.config/systemd/user/mikka-daemon.service')
  const events: string[] = []
  try {
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, 'another daemon service')
    await uninstallService(() => { events.push('credential') }, {
      manager: undefined, home, uid: 1000,
      run: async () => { throw new Error('Foreground daemon has no managed service') },
      exit: () => { events.push('exit') },
    })
    expect(await readFile(file, 'utf8')).toBe('another daemon service')
    expect(events).toEqual(['credential', 'exit'])
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('does not request a restart or receipt when teardown begins during npm installation', async () => {
  const events: string[] = []
  let stopped = false
  await restartService(true, () => { events.push('receipt') }, {
    manager: 'systemd', update: async () => { stopped = true }, restart: () => { events.push('restart') },
  }, () => !stopped)
  expect(events).toEqual([])
})
