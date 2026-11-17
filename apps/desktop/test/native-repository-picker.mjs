import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// This is the existing cross-platform acceptance fixture for Git and IPC.
export function verifyPickedRepository(application, page, directory) {
  return verifyRepositoryChoices(directory, async path => {
    await application.evaluate(({ dialog }, selected) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original
        return selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] }
      }
    }, path)
    return page.evaluate(() => window.mikka.device.pickRepo())
  })
}

// Only called inside the Linux smoke job's isolated Xvfb display. No account
// or renderer-supplied path enters the product's directory picker.
export function verifyLinuxRepositoryDialog(page, directory) {
  const driver = fileURLToPath(new URL('./linux-directory-dialog.py', import.meta.url))
  const driveDialog = path => execute('/usr/bin/python3', [driver, ...(path ? [path] : [])], { timeout: 20_000 })
  return verifyRepositoryChoices(directory, async path => {
    const timeout = new AbortController()
    try {
      const [result] = await Promise.race([
        Promise.all([page.evaluate(() => window.mikka.device.pickRepo()), driveDialog(path)]),
        delay(23_000, undefined, { signal: timeout.signal }).then(() => { throw new Error('NATIVE_DIRECTORY_DIALOG_TIMEOUT') }),
      ])
      return result
    } finally { timeout.abort() }
  })
}

async function verifyRepositoryChoices(directory, selectFolder) {
  const repo = await mkdtemp(join(directory, 'picked-repository-'))
  try {
    const child = join(repo, 'src')
    await mkdir(child)
    execFileSync('git', ['init', '--quiet', repo])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.invalid/review.git'])
    const expected = { status: 'picked', repo: { path: await realpath(repo), name: basename(repo), remoteUrl: 'https://example.invalid/review.git' } }
    assert.deepEqual(await selectFolder(child), expected)
    execFileSync('git', ['-C', repo, 'remote', 'rename', 'origin', 'upstream'])
    assert.deepEqual(await selectFolder(child), expected)
    assert.deepEqual(await selectFolder(null), { status: 'cancelled' })
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}
