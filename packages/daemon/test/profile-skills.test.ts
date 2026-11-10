import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { RunContext, prepareRunContextFiles } from '../src/agents/run-context'
import { createMikkaMcpBackend } from '../src/agents/mikka-mcp-backend.mjs'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterAll(cleanupTempDirs)

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function repositorySkill(root: string, directory: string, body: string) {
  const dir = join(root, directory)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), body)
}

async function context(options: { profileSkills?: unknown[]; repositorySkills?: string[] } = {}) {
  const worktree = await makeRepo()
  const stateDir = tempDir('profile-skills-')
  const ctx = new RunContext({
    harness: 'claude_code', worktree, runDir: join(stateDir, 'runs', 'run-1'), privateDir: stateDir,
    ...(options.profileSkills ? { profileSkills: options.profileSkills as never } : {}),
    ...(options.repositorySkills ? { repositorySkills: options.repositorySkills } : {}),
  })
  return { ctx, worktree, stateDir }
}

const assigned = {
  id: 'official:systematic-debugging', name: 'Systematic debugging', description: 'Reproduce and verify.',
  source: 'official' as const, digest: sha256('Reproduce first, then fix the root cause.'),
  instructions: 'Reproduce first, then fix the root cause.',
}

describe('Profile Skills in a daemon run', () => {
  it('writes only the pinned manifest under the run dir, never into the worktree', async () => {
    const { ctx, worktree } = await context({ profileSkills: [assigned] })
    const manifest = JSON.parse(readFileSync(join(ctx.profileSkillsDir, 'manifest.json'), 'utf8'))
    expect(manifest).toEqual({ version: 1, skills: [{
      id: assigned.id, name: assigned.name, description: assigned.description, source: 'official',
      digest: assigned.digest, instructions: assigned.instructions, available: true,
    }] })
    expect(existsSync(join(worktree, 'profile-skills'))).toBe(false)
    expect(existsSync(join(worktree, 'SKILL.md'))).toBe(false)
    expect(ctx.instructions()).not.toContain(assigned.instructions)
    expect(ctx.instructions()).not.toContain('load_skill')
  })

  it('rejects a body whose digest does not match the frozen assignment', async () => {
    await expect(context({ profileSkills: [{ ...assigned, digest: sha256('different') }] }))
      .rejects.toThrow('Profile Skill artifact digest mismatch')
  })

  it('pins declared repository Skills from the checkout and reports a missing or unsafe one', async () => {
    const worktree = await makeRepo()
    repositorySkill(worktree, '.claude/skills/tdd', '---\nname: tdd\ndescription: Test first.\n---\n\nWrite the failing check first.\n')
    repositorySkill(worktree, '.agents/skills/review', 'Read the candidate independently.\n')
    mkdirSync(join(worktree, '.claude/skills/escape'), { recursive: true })
    symlinkSync('/etc/hosts', join(worktree, '.claude/skills/escape', 'SKILL.md'))
    const stateDir = tempDir('profile-skills-')
    const ctx = new RunContext({
      harness: 'codex', worktree, runDir: join(stateDir, 'runs', 'run-1'), privateDir: stateDir,
      repositorySkills: ['tdd', 'review', 'escape', 'missing'],
    })
    const manifest = JSON.parse(readFileSync(join(ctx.profileSkillsDir, 'manifest.json'), 'utf8'))
    const byId = new Map(manifest.skills.map((skill: { id: string }) => [skill.id, skill]))
    expect(byId.get('repository:tdd')).toMatchObject({ available: true, name: 'tdd', description: 'Test first.', source: 'repository' })
    expect(byId.get('repository:tdd').instructions).toContain('Write the failing check first.')
    expect(byId.get('repository:review')).toMatchObject({ available: true, name: 'review' })
    expect(byId.get('repository:escape')).toMatchObject({ available: false, reason: 'invalid' })
    expect(byId.get('repository:missing')).toMatchObject({ available: false, reason: 'not_found' })
    // The body is pinned at start: a later edit cannot change what load_skill serves.
    writeFileSync(join(worktree, '.claude/skills/tdd', 'SKILL.md'), 'Changed after start.\n')
    const pinned = JSON.parse(readFileSync(join(ctx.profileSkillsDir, 'manifest.json'), 'utf8'))
    expect(pinned.skills.find((skill: { id: string }) => skill.id === 'repository:tdd').instructions).toContain('Write the failing check first.')
  })

  it('creates the manifest during preparation so a prewarmed MCP child can resolve it, then pins the checkout', async () => {
    const worktree = await makeRepo(), stateDir = tempDir('profile-skills-')
    repositorySkill(worktree, '.claude/skills/tdd', 'Pinned after the checkout.\n')
    const options = { harness: 'claude_code' as const, worktree, runDir: join(stateDir, 'runs', 'run-1'), privateDir: stateDir,
      profileSkills: [assigned], repositorySkills: ['tdd'] }
    const files = prepareRunContextFiles(options)
    const prepared = JSON.parse(readFileSync(join(files.runDir, 'profile-skills', 'manifest.json'), 'utf8'))
    expect(prepared.skills.find((skill: { id: string }) => skill.id === 'repository:tdd')).toMatchObject({ available: false, reason: 'pending' })
    new RunContext(options)
    const pinned = JSON.parse(readFileSync(join(files.runDir, 'profile-skills', 'manifest.json'), 'utf8'))
    expect(pinned.skills.find((skill: { id: string }) => skill.id === 'repository:tdd')).toMatchObject({ available: true })
  })

  it('serves one pinned body through load_skill and records a verifiable receipt', async () => {
    const { ctx } = await context({ profileSkills: [assigned] })
    const backend = createMikkaMcpBackend({ handoffFile: join(ctx.runDir, 'handoff.json'), profileSkillsDir: ctx.profileSkillsDir, env: { PATH: process.env.PATH } })
    const listed = await backend.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const tools = ((listed?.result as { tools?: { name: string }[] } | undefined)?.tools ?? [])
    expect(tools.map(tool => tool.name)).toContain('load_skill')
    const loaded = await backend.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'load_skill', arguments: { id: assigned.id } } })
    expect(loaded?.error).toBeUndefined()
    const content = (loaded?.result as { content: { type: string; text: string }[] }).content
    const payload = JSON.parse(content[0].text)
    expect(payload).toEqual({ id: assigned.id, name: assigned.name, source: 'official', digest: assigned.digest, instructions: assigned.instructions })
    const receipts = readdirSync(join(ctx.profileSkillsDir, 'loaded'))
    expect(receipts).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(ctx.profileSkillsDir, 'loaded', receipts[0]), 'utf8')))
      .toMatchObject({ id: assigned.id, source: 'official', digest: assigned.digest })
    const refused = await backend.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'load_skill', arguments: { id: 'official:unknown' } } })
    expect((refused?.result as { isError?: boolean }).isError).toBe(true)
    await backend.close()
  })
})
