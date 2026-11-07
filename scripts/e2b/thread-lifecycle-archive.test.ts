import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { takeCheckpoint } from '../../packages/daemon/src/agents/checkpoint'
import { ARCHIVE_BASELINE, ARCHIVE_GIT_ENV, ARCHIVE_GIT_OPTIONS, recoverAcceptanceArchive } from './thread-lifecycle-archive'

test('the retirement fixture recovers actual checkpoint bytes independently and refuses missing or wrong data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-lifecycle-source-'))
  const git = (args: string[]) => execFileSync('git', [...ARCHIVE_GIT_OPTIONS, ...args], {
    cwd: directory, env: { ...process.env, ...ARCHIVE_GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  try {
    git(['init', '--quiet', '--initial-branch=main', '--object-format=sha1'])
    await writeFile(join(directory, 'baseline.txt'), ARCHIVE_BASELINE)
    git(['add', 'baseline.txt']); git(['commit', '--quiet', '-m', 'Disposable lifecycle baseline'])
    const baseCommit = git(['rev-parse', 'HEAD']), content = 'Unique disposable work preserved through retirement\n'
    const worktree = join(directory, 'source-worktree')
    git(['worktree', 'add', '--quiet', '--detach', worktree, baseCommit])
    await writeFile(join(worktree, 'deliverable.txt'), content)
    const taken = await takeCheckpoint({ repoPath: directory, worktree, baseCommit })
    assert.ok(taken)
    await recoverAcceptanceArchive(taken.checkpoint, content)
    await assert.rejects(recoverAcceptanceArchive(taken.checkpoint, 'other bytes'), /archive_content_mismatch/)
    await assert.rejects(recoverAcceptanceArchive({ ...taken.checkpoint, baseCommit: 'f'.repeat(40) }, content), /archive_base_mismatch/)
    await assert.rejects(recoverAcceptanceArchive({ ...taken.checkpoint, unavailableReason: 'too_large' }, content), /archive_unavailable/)
    await assert.rejects(recoverAcceptanceArchive({ ...taken.checkpoint, files: 0, patch: gzipSync(Buffer.alloc(0)).toString('base64') }, content))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
