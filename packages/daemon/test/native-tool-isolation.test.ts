import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeRunToolConfig, nativeToolConfigArgs, nativeToolEnvironment, nativeToolFilesystem } from '../src/agents/native-tool-isolation.mjs'
import { claudeIsolatedTools } from '../src/adapters/claude'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function config() {
  const root = mkdtempSync(join(tmpdir(), 'mikka-native-tools-unit-')); roots.push(root)
  return nativeRunToolConfig({ binary: '/usr/bin/codex', worktree: join(root, 'work'), runDir: join(root, 'run'),
    privateRoots: [join(root, 'native-home')], taskEnv: { REGION: 'fixture', ANTHROPIC_API_KEY: 'must-not-be-a-tool-key', NODE_OPTIONS: '--require=/private/loader', HOME: '/private' } })
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
