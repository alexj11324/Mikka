/** Disposable Git data used only by the guarded, isolated lifecycle driver. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunCheckpoint } from '@mikka/protocol/device'
import { applyCheckpoint } from '../../packages/daemon/src/agents/checkpoint'

export const ARCHIVE_BASELINE = 'Disposable lifecycle baseline\n'
export const ARCHIVE_GIT_ENV = {
  GIT_AUTHOR_NAME: 'Lifecycle fixture', GIT_AUTHOR_EMAIL: 'lifecycle@example.invalid',
  GIT_COMMITTER_NAME: 'Lifecycle fixture', GIT_COMMITTER_EMAIL: 'lifecycle@example.invalid',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
}
export const ARCHIVE_GIT_OPTIONS = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false']

/** Rebuild the known base independently, then apply the actual saved bytes.
 * Neither the expected file nor its body is copied into the recovery tree. */
export async function recoverAcceptanceArchive(checkpoint: RunCheckpoint, expected: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-lifecycle-archive-'))
  const repo = join(directory, 'repo'), worktree = join(directory, 'recovered')
  const git = (args: string[]) => execFileSync('git', [...ARCHIVE_GIT_OPTIONS, ...args], {
    cwd: repo, env: { ...process.env, ...ARCHIVE_GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  try {
    await mkdir(repo)
    git(['init', '--quiet', '--initial-branch=main', '--object-format=sha1'])
    await writeFile(join(repo, 'baseline.txt'), ARCHIVE_BASELINE)
    git(['add', 'baseline.txt']); git(['commit', '--quiet', '-m', 'Disposable lifecycle baseline'])
    assert.equal(git(['rev-parse', 'HEAD']), checkpoint.baseCommit, 'archive_base_mismatch')
    git(['worktree', 'add', '--quiet', '--detach', worktree, checkpoint.baseCommit])
    assert.equal(checkpoint.unavailableReason, undefined, 'archive_unavailable')
    assert.equal(await applyCheckpoint({ repoPath: repo, worktree, checkpoint }), true, 'archive_restore_failed')
    assert.equal(await readFile(join(worktree, 'deliverable.txt'), 'utf8'), expected, 'archive_content_mismatch')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
