import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// This is the existing cross-platform acceptance fixture for Git and IPC.
export async function verifyPickedRepository(application, page, directory) {
  const repo = await mkdtemp(join(directory, 'picked-repository-'))
  return verifyRepositoryChoices(repo, 'src', async path => {
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

// The bookmark is ordinary GTK configuration in this disposable profile. It
// opens the parent in the native chooser; a separate child row must be selected.
export async function prepareLinuxRepositoryDialog(profile) {
  await mkdir(profile, { recursive: true })
  const repo = await mkdtemp(join(profile, 'picked-repository-'))
  const config = await mkdtemp(join(profile, 'picker-xdg-'))
  for (const version of ['gtk-3.0', 'gtk-4.0']) {
    const settings = join(config, version)
    await mkdir(settings)
    await writeFile(join(settings, 'bookmarks'), pathToFileURL(repo).href + ' Fixture\n')
  }
  return { repo, config }
}

async function driveLinuxDirectoryDialog(choose, step, open) {
  const driver = fileURLToPath(new URL('./linux-directory-dialog.py', import.meta.url))
  const timeout = new AbortController()
  const input = execute('/usr/bin/python3', [driver, choose ? 'choose' : 'cancel'], { timeout: 25_000 })
    .then(({ stdout }) => console.log('Native repository ' + step + ': ' + stdout.trim()))
  try {
    const [result] = await Promise.race([
      Promise.all([open(), input]),
      delay(28_000, undefined, { signal: timeout.signal }).then(() => { throw new Error('NATIVE_DIRECTORY_DIALOG_TIMEOUT_' + step) }),
    ])
    return result
  } finally { timeout.abort() }
}

export function verifyLinuxRepositoryDialog(page, fixture, verifyProject) {
  return verifyRepositoryChoices(fixture.repo, 'Source', async (path, step) => {
    const result = await driveLinuxDirectoryDialog(Boolean(path), step, () => page.evaluate(() => window.mikka.device.pickRepo()))
    console.log('Native repository ' + step + ' result: ' + result.status)
    return result
  }, verifyProject && (root => verifyProject(root, open => driveLinuxDirectoryDialog(true, 'project', open))))
}

async function verifyRepositoryChoices(repo, childName, selectFolder, verifyProject) {
  try {
    const child = join(repo, childName)
    await mkdir(child)
    execFileSync('git', ['init', '--quiet', repo])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.invalid/review.git'])
    const expected = { status: 'picked', repo: { path: await realpath(repo), name: basename(repo), remoteUrl: 'https://example.invalid/review.git' } }
    assert.deepEqual(await selectFolder(child, 'origin'), expected)
    execFileSync('git', ['-C', repo, 'remote', 'rename', 'origin', 'upstream'])
    assert.deepEqual(await selectFolder(child, 'upstream'), expected)
    assert.deepEqual(await selectFolder(null, 'cancel'), { status: 'cancelled' })
    if (verifyProject) await verifyProject(expected.repo.path)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}
