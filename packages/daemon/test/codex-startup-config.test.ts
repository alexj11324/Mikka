import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorktreeManager } from '../src/worktrees'
import { worktreeGitWritePaths } from '../src/agents/publish'
import { cleanupTempDirs, makeRepo } from './helpers'
import { afterEach, describe, expect, it } from 'vitest'
import { captureCodexSystemSkills, codexAnonymousHomeEligible, codexAnonymousParkingEligible, codexAnonymousRepositoryEligible } from '../src/codex-startup-config'
const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-config-')); roots.push(root)
  const home = join(root, 'home'), cwd = join(home, 'workspace', 'repo')
  mkdirSync(join(home, '.codex'), { recursive: true }); mkdirSync(join(cwd, '.git'), { recursive: true })
  return { root, home, cwd, env: { HOME: home } }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); cleanupTempDirs() })
describe('anonymous Codex configuration qualification', () => {
  it('accepts an ordinary unconfigured home and real initial repository', async () => {
    const f = fixture(); expect(await codexAnonymousRepositoryEligible(f.cwd, f.env)).toBe(true)
  })
  it.each(['config.toml', 'auth.json', 'plugins', 'hooks.json', 'skills', 'rules'])('keeps HOME %s on the original cold path', async name => {
    const f = fixture(); writeFileSync(join(f.home, '.codex', name), 'opaque-do-not-read')
    expect(await codexAnonymousHomeEligible(f.env)).toBe(false)
  })
  it.each(['.codex', '.agents'])('does not ignore final project %s', async name => {
    const f = fixture(); mkdirSync(join(f.cwd, name)); expect(await codexAnonymousRepositoryEligible(f.cwd, f.env)).toBe(false)
  })
  it('rejects config that appears in a parent after preparation', async () => {
    const f = fixture(); expect(await codexAnonymousHomeEligible(f.env)).toBe(true)
    mkdirSync(join(f.root, '.codex')); expect(await codexAnonymousRepositoryEligible(f.cwd, f.env)).toBe(false)
  })
  it('rejects unbound linked worktree metadata and symlink checkout', async () => {
    const f = fixture(); rmSync(join(f.cwd, '.git'), { recursive: true }); writeFileSync(join(f.cwd, '.git'), 'gitdir: ../other')
    expect(await codexAnonymousRepositoryEligible(f.cwd, f.env)).toBe(false)
    symlinkSync(f.cwd, join(f.root, 'link')); expect(await codexAnonymousRepositoryEligible(join(f.root, 'link'), f.env)).toBe(false)
  })
  it('rejects auth env, alternate HOME configuration and absent checkout', async () => {
    const f = fixture()
    expect(await codexAnonymousHomeEligible({ ...f.env, OPENAI_API_KEY: 'synthetic-key' })).toBe(false)
    expect(await codexAnonymousHomeEligible({ ...f.env, CODEX_HOME: join(f.root, 'alternate') })).toBe(false)
    expect(await codexAnonymousRepositoryEligible(join(f.root, 'missing'), f.env)).toBe(false)
  })
  it('admits only the unchanged system skills created by its own initialization', async () => {
    const f = fixture()
    expect(await codexAnonymousHomeEligible(f.env)).toBe(true)
    const system = join(f.home, '.codex', 'skills', '.system')
    mkdirSync(system, { recursive: true })
    writeFileSync(join(system, '.codex-system-skills.marker'), 'fixed-native-marker')
    writeFileSync(join(system, 'SKILL.md'), 'public embedded skill')
    const owned = await captureCodexSystemSkills(f.env)
    expect(owned).toBeDefined()
    expect(await codexAnonymousHomeEligible(f.env)).toBe(false)
    expect(await codexAnonymousRepositoryEligible(f.cwd, f.env, owned)).toBe(true)
    writeFileSync(join(system, 'SKILL.md'), 'changed skill')
    expect(await codexAnonymousRepositoryEligible(f.cwd, f.env, owned)).toBe(false)
  })
  it('does not hide user skills, links, missing markers or a different HOME behind the system proof', async () => {
    const f = fixture(), system = join(f.home, '.codex', 'skills', '.system')
    mkdirSync(system, { recursive: true })
    await expect(captureCodexSystemSkills(f.env)).rejects.toThrow('marker')
    writeFileSync(join(system, '.codex-system-skills.marker'), 'fixed-native-marker')
    const owned = await captureCodexSystemSkills(f.env)
    expect(await codexAnonymousHomeEligible({ HOME: f.root }, owned)).toBe(false)
    mkdirSync(join(f.home, '.codex', 'skills', 'custom'))
    expect(await codexAnonymousRepositoryEligible(f.cwd, f.env, owned)).toBe(false)
    rmSync(join(f.home, '.codex', 'skills', 'custom'), { recursive: true })
    symlinkSync(join(system, '.codex-system-skills.marker'), join(system, 'linked'))
    expect(await codexAnonymousRepositoryEligible(f.cwd, f.env, owned)).toBe(false)
  })

  it('keeps HOME/.agents active and does not exempt a symlink spelling of HOME', async () => {
    const f = fixture()
    mkdirSync(join(f.home, '.agents'))
    expect(await codexAnonymousRepositoryEligible(f.cwd, f.env)).toBe(false)
    rmSync(join(f.home, '.agents'), { recursive: true })
    symlinkSync(f.home, join(f.root, 'home-alias'))
    expect(await codexAnonymousRepositoryEligible(f.cwd, { HOME: join(f.root, 'home-alias') })).toBe(false)
  })
  it('checks parking ancestors even when they differ from the final repository', async () => {
    const f = fixture(), parking = join(f.home, '.mikka', 'worker', 'adapters', 'parking')
    mkdirSync(parking, { recursive: true })
    expect(await codexAnonymousParkingEligible(parking, f.env)).toBe(true)
    mkdirSync(join(f.home, '.mikka', 'worker', 'adapters', '.codex'))
    expect(await codexAnonymousParkingEligible(parking, f.env)).toBe(false)
    expect(await codexAnonymousRepositoryEligible(f.cwd, f.env)).toBe(true)
  })
  it('refuses a linked user config directory instead of skipping its contents as project settings', async () => {
    const f = fixture()
    rmSync(join(f.home, '.codex'), { recursive: true })
    mkdirSync(join(f.root, 'config-target'))
    symlinkSync(join(f.root, 'config-target'), join(f.home, '.codex'))
    expect(await codexAnonymousHomeEligible(f.env)).toBe(false)
    expect(await codexAnonymousRepositoryEligible(f.cwd, f.env)).toBe(false)
  })

})

async function realWorktree() {
  const f = fixture(), repositoryRoot = join(f.home, '.mikka', 'repos', 'main')
  mkdirSync(dirname(repositoryRoot), { recursive: true }); renameSync(await makeRepo(), repositoryRoot)
  const runId = randomUUID(), cwd = await new WorktreeManager(join(f.home, '.mikka', 'worker', 'worktrees')).create(runId, repositoryRoot, 'main')
  const trusted = await worktreeGitWritePaths(repositoryRoot, cwd, runId)
  expect(trusted).toEqual([repositoryRoot])
  const gitdir = readFileSync(join(cwd, '.git'), 'utf8').trim().slice('gitdir: '.length)
  return { ...f, cwd, repositoryRoot, gitdir, eligible: () => codexAnonymousRepositoryEligible(cwd, f.env, undefined, trusted[0]) }
}

describe('host-proven native Git worktrees', () => {
  it('accepts the actual WorktreeManager product only with its validated primary clone', async () => {
    const f = await realWorktree()
    expect(await f.eligible()).toBe(true)
    expect(await codexAnonymousRepositoryEligible(f.cwd, f.env)).toBe(false)
    expect(await codexAnonymousRepositoryEligible(f.cwd, f.env, undefined, f.root)).toBe(false)
  })
  it.each(['.codex', '.agents'])('keeps primary checkout %s configuration relevant to linked worktrees', async name => {
    const f = await realWorktree()
    mkdirSync(join(f.repositoryRoot, name))
    expect(await f.eligible()).toBe(false)
  })
  it('checks primary ancestors as well as the separate worktree ancestors', async () => {
    const f = await realWorktree()
    mkdirSync(join(dirname(f.repositoryRoot), '.codex'))
    expect(await f.eligible()).toBe(false)
  })
  it.each(['pointer', 'backlink', 'commondir', 'worktree-config', 'common-config', 'pointer-link', 'gitdir-link'])('rejects changed or external %s metadata', async kind => {
    const f = await realWorktree()
    expect(await f.eligible()).toBe(true)
    if (kind === 'pointer') writeFileSync(join(f.cwd, '.git'), 'gitdir: ' + join(f.root, 'external') + '\n')
    if (kind === 'backlink') writeFileSync(join(f.gitdir, 'gitdir'), join(f.root, 'other', '.git') + '\n')
    if (kind === 'commondir') writeFileSync(join(f.gitdir, 'commondir'), f.root + '\n')
    if (kind === 'worktree-config') writeFileSync(join(f.gitdir, 'config.worktree'), '[core]\nbare = false\n')
    if (kind === 'common-config') writeFileSync(join(f.repositoryRoot, '.git', 'config.worktree'), '[core]\nbare = false\n')
    if (kind === 'pointer-link') {
      renameSync(join(f.cwd, '.git'), join(f.root, 'pointer'))
      symlinkSync(join(f.root, 'pointer'), join(f.cwd, '.git'))
    }
    if (kind === 'gitdir-link') {
      renameSync(f.gitdir, join(f.root, 'external-gitdir'))
      symlinkSync(join(f.root, 'external-gitdir'), f.gitdir)
    }
    expect(await f.eligible()).toBe(false)
  })
})
