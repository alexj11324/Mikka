import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { githubHosts, prepareMachineGitHub } from '../src/agents/machine-github'
import { cleanupTempDirs, tempDir } from './helpers'

afterEach(() => { vi.useRealTimers(); cleanupTempDirs() })
const github = { endpoint: 'https://mikka.example/api/runs/github-token', repository: 'owner/repo', issueId: 'issue',
  token: 'synthetic-owner-github-token', expiresAt: null }

it('uses the ordinary gh login and binary, preserving other hosts and avoiding command-time HTTP', async () => {
  vi.useFakeTimers()
  const home = tempDir(), directory = join(home, '.config', 'gh'), file = join(directory, 'hosts.yml')
  mkdirSync(directory, { recursive: true })
  const original = 'enterprise.example:\n    oauth_token: enterprise-owner-token\ngithub.com:\n    oauth_token: original-login\n'
  writeFileSync(file, original)
  const refresh = vi.fn(async () => { throw Error('no expiry requires no HTTP') })
  const prepared = prepareMachineGitHub(github, { env: { HOME: home }, signal: new AbortController().signal, refresh })
  expect(readFileSync(file, 'utf8')).toContain('enterprise-owner-token')
  expect(readFileSync(file, 'utf8')).toContain(github.token)
  expect(prepared.env.GIT_CONFIG_VALUE_1).toBe('!gh auth git-credential')
  expect(JSON.stringify(prepared.env)).not.toContain(github.token)
  await vi.advanceTimersByTimeAsync(24 * 3_600_000)
  expect(refresh).not.toHaveBeenCalled()
  prepared.close()
  expect(readFileSync(file, 'utf8')).toBe(original)
})

it('updates the native login before expiry without any per-operation exchange, retaining it for finalization', async () => {
  vi.useFakeTimers()
  const home = tempDir(), file = join(home, '.config', 'gh', 'hosts.yml'), controller = new AbortController()
  const refresh = vi.fn(async () => ({ token: 'synthetic-renewed-github-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }))
  const onCredential = vi.fn()
  const prepared = prepareMachineGitHub({ ...github, expiresAt: new Date(Date.now() + 120_000).toISOString() },
    { env: { HOME: home }, signal: controller.signal, refresh, onCredential })
  await vi.advanceTimersByTimeAsync(89_999)
  expect(refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(refresh).toHaveBeenCalledOnce()
  expect(readFileSync(file, 'utf8')).toContain('synthetic-renewed-github-token')
  expect(onCredential).toHaveBeenLastCalledWith('GITHUB_TOKEN', 'synthetic-renewed-github-token')
  controller.abort()
  expect(existsSync(file)).toBe(true)
  prepared.close({ retainCredential: true })
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(refresh).toHaveBeenCalledOnce()
  expect(readFileSync(file, 'utf8')).toContain('synthetic-renewed-github-token')
})

it('does not erase a later manual native login change on cleanup', () => {
  const home = tempDir(), file = join(home, '.config', 'gh', 'hosts.yml')
  const prepared = prepareMachineGitHub(github, { env: { HOME: home }, signal: new AbortController().signal, refresh: async () => github })
  writeFileSync(file, 'github.com:\n    oauth_token: later-owner-login\n')
  prepared.close()
  expect(readFileSync(file, 'utf8')).toContain('later-owner-login')
})

it('retains unrelated JSON/YAML hosts and refuses invalid credentials without writing them', () => {
  expect(JSON.parse(githubHosts('{"enterprise.example":{"user":"person"}}', github.token)))
    .toMatchObject({ 'enterprise.example': { user: 'person' }, 'github.com': { oauth_token: github.token } })
  expect(() => githubHosts('', 'bad\ncredential')).toThrow('invalid')
  expect(() => githubHosts('github.com: {oauth_token: existing}\n', github.token)).toThrow('configuration_invalid')
})
