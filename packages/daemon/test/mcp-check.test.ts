import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { mcpDeviceCheckReceiptSchema, type McpDeviceCheckCommand, type McpDeviceCheckReceipt } from '@mikka/protocol/mcp-check'
import { checkStdioMcp } from '../src/mcp-check'
import { Daemon } from '../src/main'
import { MemoryServer } from '../src/server-link'
import { createLogger } from '../src/log'
import { cleanupTempDirs, tempDir, waitFor } from './helpers'

const daemons: Daemon[] = []
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.stop(); cleanupTempDirs() })

function fixture() {
  const directory = tempDir(), marker = join(directory, 'calls'), script = fileURLToPath(new URL('./fakes/mcp-settings.mjs', import.meta.url))
  const command: McpDeviceCheckCommand = { id: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    server: { name: 'mcp_fixture', transport: 'stdio', command: process.execPath, args: [script], cwd: directory, env: { SERVICE_TOKEN: 'synthetic-owner-credential', MCP_TEST_RECORD: marker } } }
  return { command, marker, directory }
}

it('executes a real STDIO handshake on the daemon, reports only safe snapshots, and performs no tool calls', async () => {
  const { command, marker } = fixture()
  const server = new MemoryServer('fixture-device'), link = server.link(), receipts: McpDeviceCheckReceipt[] = []
  const read = link.fetchCommands.bind(link), report = link.report.bind(link)
  link.fetchCommands = async (id, wait, options) => {
    options?.onMcpChecks?.([command])
    return read(id, wait, options)
  }
  link.report = async (id, fields) => {
    receipts.push(...(fields.mcpChecks ?? []).map(value => mcpDeviceCheckReceiptSchema.parse(value)))
    return report(id, fields)
  }
  const daemon = await new Daemon({ dataDir: tempDir(), flavor: 'dev', link, credential: 'synthetic-device', agentSandbox: null,
    harnesses: [], quotaSource: null, log: createLogger({ level: 'silent' }) }).start()
  daemons.push(daemon)
  await daemon.syncWithServer()
  await waitFor(() => receipts.length === 1)
  expect(receipts).toEqual([{ id: command.id, status: 'connected', tools: [{ name: 'read_docs', description: 'Read [redacted]' }] }])
  await daemon.syncWithServer()
  expect(receipts).toHaveLength(1)
  expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
  expect(readFileSync(daemon.paths.device, 'utf8')).not.toContain('synthetic-owner-credential')
})

it('refuses expired commands before starting a process and persists safe failure codes for an unavailable program', async () => {
  const { command, marker } = fixture()
  expect(await checkStdioMcp({ ...command, expiresAt: new Date(0).toISOString() })).toEqual({ id: command.id, status: 'check_failed', failureReason: 'checkExpired' })
  expect(existsSync(marker)).toBe(false)
  expect(await checkStdioMcp({ ...command, server: { ...command.server, command: '/does-not-exist/mcp' } })).toEqual({ id: command.id, status: 'check_failed', failureReason: 'processFailed' })
})
