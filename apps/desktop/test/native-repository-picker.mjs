import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

// The fixture supplies only the OS selection. The renderer, IPC, native
// process and Git all use the actual checkout and the packaged implementation.
export async function verifyPickedRepository(application, page, directory) {
  const repo = await mkdtemp(join(directory, 'picked-repository-'))
  try {
    const child = join(repo, 'src')
    await mkdir(child)
    execFileSync('git', ['init', '--quiet', repo])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.invalid/review.git'])
    const expected = { status: 'picked', repo: { path: await realpath(repo), name: basename(repo), remoteUrl: 'https://example.invalid/review.git' } }
    async function selectFolder(path) {
      await application.evaluate(({ dialog }, selected) => {
        const original = dialog.showOpenDialog
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original
          return selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] }
        }
      }, path)
      return page.evaluate(() => window.mikka.device.pickRepo())
    }
    assert.deepEqual(await selectFolder(child), expected)
    execFileSync('git', ['-C', repo, 'remote', 'rename', 'origin', 'upstream'])
    assert.deepEqual(await selectFolder(child), expected)
    assert.deepEqual(await selectFolder(null), { status: 'cancelled' })
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}
