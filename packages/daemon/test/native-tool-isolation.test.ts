import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeControllerCommand, nativeRunToolConfig, nativeToolConfigArgs, nativeToolEnvironment, nativeToolFilesystem } from '../src/agents/native-tool-isolation.mjs'
import { claudeIsolatedTools, requireClaudeIsolatedTransport } from '../src/adapters/claude'
import type { Query } from '@anthropic-ai/claude-agent-sdk'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function config() {
  const root = mkdtempSync(join(tmpdir(), 'mikka-native-tools-unit-')); roots.push(root)
  return nativeRunToolConfig({ binary: '/usr/bin/codex', worktree: join(root, 'work'), runDir: join(root, 'run'),
    privateRoots: [join(root, 'native-home')], taskEnv: { REGION: 'fixture', ANTHROPIC_API_KEY: 'must-not-be-a-tool-key', NODE_OPTIONS: '--require=/private/loader', HOME: '/private' } })
}
function controllerFixture() {
  const value = config(), vendor = join(roots.at(-1)!, 'vendor')
  mkdirSync(join(vendor, 'bin'), { recursive: true })
  mkdirSync(join(vendor, 'codex-resources'))
  value.binary = join(vendor, 'bin', 'codex')
  for (const binary of [value.binary, join(vendor, 'codex-resources', 'bwrap')])
    writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  mkdirSync(value.worktree)
  return value
}

it('separates trusted native authentication and loader variables from explicitly admitted task variables', () => {
  const value = config()
  const env = nativeToolEnvironment(value, { ANTHROPIC_API_KEY: 'host-claude', MIKKA_MODEL_API_KEY: 'host-openai',
    GITHUB_TOKEN: 'host-git', CODEX_HOME: '/private/codex', NODE_OPTIONS: '--require=/private/loader',
    HTTPS_PROXY: 'https://user:private-token@proxy.invalid', HTTP_PROXY: 'http://proxy.invalid:8080', NO_PROXY: 'localhost' })
  expect(env).toMatchObject({ REGION: 'fixture', HOME: value.home, TMPDIR: value.temp, HTTP_PROXY: 'http://proxy.invalid:8080', NO_PROXY: 'localhost' })
  for (const name of ['ANTHROPIC_API_KEY', 'MIKKA_MODEL_API_KEY', 'GITHUB_TOKEN', 'CODEX_HOME', 'NODE_OPTIONS', 'HTTPS_PROXY']) expect(env[name]).toBeUndefined()
  expect(Object.values(env).join('\n')).not.toMatch(/private-token|must-not-be|host-claude|host-openai|host-git/)
})

it('creates an explicit read allowlist and refuses a worktree that would expose the controller', () => {
  const value = config(), filesystem = nativeToolFilesystem(value)
  expect(filesystem[':minimal']).toBe('read')
  expect(filesystem['/']).toBeUndefined()
  expect(filesystem[value.worktree]).toBe('write')
  expect(filesystem[value.control]).toBe('deny')
  expect(filesystem[join(value.worktree, '.git')]).toBe('read')
  expect(nativeToolFilesystem({ ...value, readOnly: true })[value.worktree]).toBe('read')
  expect(() => nativeToolFilesystem({ ...value, worktree: join(value.worktree, '..') })).toThrow()
  expect(() => nativeToolFilesystem({ ...value, control: join(value.worktree, 'controller') })).toThrow()
  expect(() => nativeToolFilesystem({ ...value, readRoots: ['/'] })).toThrow()
})

it('requires the official named profile, clean shell environment and disabled untrusted project hooks', () => {
  const value = config(), args = nativeToolConfigArgs(value, {})
  expect(args).toContain('default_permissions="mikka_tools_v1"')
  expect(args).toContain('shell_environment_policy.inherit="none"')
  expect(args).toContain('shell_environment_policy.ignore_default_excludes=false')
  expect(args).toContain('features.hooks=false')
  expect(args).toContain('features.codex_hooks=false')
  expect(args).toContain(`projects.${JSON.stringify(value.worktree)}.trust_level="untrusted"`)
  expect(args.join('\n')).not.toContain('must-not-be-a-tool-key')
})

it('gives the native controller a lifetime namespace and hides project MCP config without rewriting it', () => {
  const value = controllerFixture()
  mkdirSync(join(value.worktree, '.codex'))
  const projectConfig = join(value.worktree, '.codex', 'config.toml')
  writeFileSync(projectConfig, 'untrusted-config-fixture')
  const argv = nativeControllerCommand(value, [value.binary, 'app-server'], { hideProjectConfig: true })
  for (const flag of ['--unshare-pid', '--die-with-parent', '--as-pid-1']) expect(argv).toContain(flag)
  const masked = argv.indexOf(join(value.control, 'repository-config-disabled'))
  expect(argv[masked - 1]).toBe('--ro-bind')
  expect(argv[masked + 1]).toBe(join(value.worktree, '.codex'))
  expect(argv.slice(-2)).toEqual([value.binary, 'app-server'])
  expect(readFileSync(projectConfig, 'utf8')).toBe('untrusted-config-fixture')
})

it('does not follow a repository config symlink when mounting the controller view', () => {
  const value = controllerFixture()
  const other = join(roots.at(-1)!, 'private'); mkdirSync(other)
  symlinkSync(other, join(value.worktree, '.codex'))
  expect(() => nativeControllerCommand(value, [value.binary, 'app-server'], { hideProjectConfig: true })).toThrow('native_tool_project_config_unsafe')
})

it('Claude removes every builtin and independently rejects a forged native tool call', async () => {
  const options = claudeIsolatedTools()
  expect(options.tools).toEqual([])
  expect(options.permissionMode).toBe('dontAsk')
  expect(options.allowDangerouslySkipPermissions).toBe(false)
  const callback = options.hooks!.PreToolUse![0].hooks[0]
  for (const name of ['Bash', 'Read', 'Edit', 'Agent', 'mcp__untrusted__run_command']) {
    const result = await callback({ hook_event_name: 'PreToolUse', tool_name: name } as never, undefined, { signal: new AbortController().signal })
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  }
  expect(await callback({ hook_event_name: 'PreToolUse', tool_name: 'mcp__mikka__run_command' } as never, undefined, { signal: new AbortController().signal })).toEqual({})
})

it('does not release the first prompt before the actual MCP handshake completes', async () => {
  let complete!: () => void, requested!: () => void
  const connected = new Promise<void>(resolve => { complete = resolve })
  const connecting = new Promise<void>(resolve => { requested = resolve })
  const status = vi.fn().mockResolvedValueOnce([{ name: 'mikka', source: 'dynamic', status: 'pending' }])
    .mockResolvedValue([{ name: 'mikka', source: 'dynamic', status: 'connected', tools: [{ name: 'run_command' }] }])
  const session = { initializationResult: async () => ({ hooks_applied: true }), mcpServerStatus: status,
    reconnectMcpServer: async (name: string) => { expect(name).toBe('mikka'); requested(); await connected } }
  let released = false
  const ready = requireClaudeIsolatedTransport(session as unknown as Query, new AbortController().signal).then(() => { released = true })
  await connecting
  expect(released).toBe(false)
  expect(status).toHaveBeenCalledTimes(1)
  complete(); await ready
  expect(released).toBe(true)
  expect(status).toHaveBeenCalledTimes(2)
})

it('revocation interrupts a hung MCP control request without authorizing a prompt', async () => {
  const abort = new AbortController()
  const session = { initializationResult: () => new Promise(() => {}), mcpServerStatus: vi.fn(), reconnectMcpServer: vi.fn() }
  const ready = requireClaudeIsolatedTransport(session as unknown as Query, abort.signal)
  abort.abort(Error('lease_revoked'))
  await expect(ready).rejects.toThrow('lease_revoked')
  expect(session.mcpServerStatus).not.toHaveBeenCalled()
})
