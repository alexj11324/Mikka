import { describe, expect, it } from 'vitest'
import { serviceDefinition, restartService } from '../src/service'

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
