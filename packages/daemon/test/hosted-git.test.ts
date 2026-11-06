import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cloneHostedGit, finishHostedGit } from '../src/agents/hosted-git'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(cleanupTempDirs)
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
}).trim()

async function fixture() {
  const repository = await makeRepo()
  const root = tempDir('mikka-shadow-')
  const source = join(root, 'worktree')
  git(repository, 'worktree', 'add', '-b', 'run-source', source)
  return { repository, source, destination: join(root, 'shadow'), runId: 'fixture-shadow', env: { PATH: process.env.PATH ?? '', HOME: root } }
}

it('gives the hosted CLI private metadata and new objects while borrowing the verified repository history', async () => {
  const f = await fixture()
  const head = git(f.source, 'rev-parse', 'HEAD')
  await cloneHostedGit(f)
  git(f.destination, 'read-tree', 'HEAD')
  expect(git(f.destination, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(f.destination, 'symbolic-ref', 'HEAD')).toBe('refs/heads/run-source')
  expect(git(f.destination, 'remote', 'get-url', 'origin')).toBe(f.source)
  expect(readFileSync(join(f.destination, '.git', 'objects', 'info', 'alternates'), 'utf8').trim()).toBe(join(f.repository, '.git', 'objects'))
  expect(git(f.destination, `--work-tree=${f.source}`, 'status', '--porcelain')).toBe('')
  writeFileSync(join(f.destination, 'private.txt'), 'private shadow object\n')
  const added = git(f.destination, 'hash-object', '-w', 'private.txt')
  expect(() => git(f.repository, 'cat-file', '-e', added)).toThrow()
  git(f.destination, 'config', 'core.description', 'shadow only')
  expect(() => git(f.repository, 'config', '--get', 'core.description')).toThrow()
})

it('keeps borrowed commits and tags readable after source refs and its worktree are pruned', async () => {
  const f = await fixture()
  git(f.repository, 'tag', '-a', 'release', '-m', 'fixture', 'HEAD')
  const head = git(f.source, 'rev-parse', 'HEAD')
  await cloneHostedGit(f)
  git(f.repository, 'worktree', 'remove', '--force', f.source)
  git(f.repository, 'update-ref', '-d', 'refs/heads/run-source')
  git(f.repository, 'update-ref', '-d', 'refs/heads/main')
  git(f.repository, 'tag', '-d', 'release')
  git(f.repository, 'reflog', 'expire', '--expire=now', '--all')
  git(f.repository, 'gc', '--prune=now')
  expect(git(f.destination, 'show', `${head}:README.md`)).toBe('# Sandbox')
  expect(git(f.destination, 'cat-file', '-t', 'release')).toBe('tag')
  git(f.destination, 'fsck', '--no-reflogs')
})

it('uses the daemon-recorded worktree rather than a replaced .git file', async () => {
  const f = await fixture()
  const foreign = await makeRepo()
  writeFileSync(join(foreign, 'foreign.txt'), 'foreign repository\n')
  git(foreign, 'add', 'foreign.txt')
  git(foreign, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'foreign')
  writeFileSync(join(f.source, '.git'), `gitdir: ${join(foreign, '.git')}\n`)
  await cloneHostedGit(f)
  expect(git(f.destination, 'rev-parse', 'HEAD')).toBe(git(f.repository, 'rev-parse', 'HEAD'))
  expect(() => git(f.destination, 'show', 'HEAD:foreign.txt')).toThrow()
  expect(git(foreign, 'for-each-ref', 'refs/mikka/runtime-shadows')).toBe('')
})

it('copies borrowed objects after the CLI stops, releases only its pins, and keeps the session independently resumable', async () => {
  const f = await fixture()
  await cloneHostedGit(f)
  const other = { ...f, destination: f.destination + '-other', runId: 'another-run' }
  await cloneHostedGit(other)
  await finishHostedGit(f)
  await finishHostedGit(f)
  expect(existsSync(join(f.destination, '.git', 'objects', 'info', 'alternates'))).toBe(false)
  expect(git(f.repository, 'for-each-ref', `refs/mikka/runtime-shadows/${f.runId}/`)).toBe('')
  expect(git(f.repository, 'for-each-ref', 'refs/mikka/runtime-shadows/another-run/')).not.toBe('')
  git(f.repository, 'worktree', 'remove', '--force', f.source)
  git(f.repository, 'update-ref', '-d', 'refs/heads/run-source')
  git(f.repository, 'update-ref', '-d', 'refs/heads/main')
  await finishHostedGit(other)
  git(f.repository, 'reflog', 'expire', '--expire=now', '--all')
  git(f.repository, 'gc', '--prune=now')
  expect(git(f.repository, 'for-each-ref', 'refs/mikka/runtime-shadows/')).toBe('')
  expect(git(f.destination, 'show', 'HEAD:README.md')).toBe('# Sandbox')
  git(f.destination, 'fsck', '--no-reflogs')
})

it('keeps the source pins when dissociating a retained session fails', async () => {
  const f = await fixture()
  await cloneHostedGit(f)
  const config = join(f.destination, '.git', 'config')
  const original = readFileSync(config, 'utf8')
  writeFileSync(config, '[invalid')
  await expect(finishHostedGit(f)).rejects.toThrow()
  expect(git(f.repository, 'for-each-ref', `refs/mikka/runtime-shadows/${f.runId}/`)).not.toBe('')
  writeFileSync(config, original)
  await finishHostedGit(f)
  expect(git(f.repository, 'for-each-ref', `refs/mikka/runtime-shadows/${f.runId}/`)).toBe('')
})

it('does not share objects when no trusted repository was supplied', async () => {
  const f = await fixture()
  await cloneHostedGit({ ...f, repository: undefined })
  expect(existsSync(join(f.destination, '.git', 'objects', 'info', 'alternates'))).toBe(false)
  expect(git(f.destination, 'rev-parse', 'HEAD')).toBe(git(f.source, 'rev-parse', 'HEAD'))
})

it('refuses a worktree that does not belong to the trusted repository', async () => {
  const f = await fixture()
  const foreign = await fixture()
  await expect(cloneHostedGit({ ...f, repository: foreign.repository })).rejects.toThrow('is not a worktree')
  expect(existsSync(f.destination)).toBe(false)
})
