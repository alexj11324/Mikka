import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { DRIVE_MAX_FILE_BYTES, isVolumeVersionId } from '../../../lib/drive/contract.ts'
import { signInDesktopAccount } from './self-hosted-conversations.mjs'

const MiB = 1024 * 1024

// A real filesystem path lets the native file chooser handle the large file.
// Passing a 100 MiB buffer to Playwright would test its transport limit instead.
async function createFixtureFile(directory, sizeMiB) {
  const name = `personal-${sizeMiB}MiB.bin`
  const path = join(directory, name)
  const block = Buffer.alloc(MiB, sizeMiB)
  const hash = createHash('sha256')
  const file = await open(path, 'wx', 0o600)
  try {
    for (let i = 0; i < sizeMiB; i++) {
      await file.writeFile(block)
      hash.update(block)
    }
  } finally { await file.close() }
  return { path, name, sizeBytes: sizeMiB * MiB, sha256: hash.digest('hex') }
}

async function verifyDownloadedFile(application, page, fixture) {
  // Playwright leaves Electron downloads under the OS's normal save-dialog
  // policy. Select the isolated destination on the actual DownloadItem.
  const destination = fixture.path + '.download'
  const window = await application.browserWindow(page)
  try {
    const [result] = await Promise.all([
      window.evaluate((win, { destination, expected }) => new Promise((resolve, reject) => {
        const session = win.webContents.session
        const timeout = setTimeout(() => {
          session.removeListener('will-download', onDownload)
          reject(new Error('PERSONAL_DRIVE_DOWNLOAD_TIMEOUT'))
        }, 60_000)
        function onDownload(_event, item, source) {
          if (source !== win.webContents || item.getFilename() !== expected) return
          session.removeListener('will-download', onDownload)
          item.setSavePath(destination)
          item.once('done', (_event, state) => {
            clearTimeout(timeout)
            resolve({ state, name: item.getFilename(), bytes: item.getReceivedBytes() })
          })
        }
        session.on('will-download', onDownload)
      }), { destination, expected: fixture.name }),
      page.getByText(fixture.name, { exact: true }).click(),
    ])
    assert.deepEqual(result, { state: 'completed', name: fixture.name, bytes: fixture.sizeBytes })
  } finally { await window.dispose() }
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(destination)) {
    hash.update(chunk)
    size += chunk.length
  }
  assert.equal(size, fixture.sizeBytes)
  assert.equal(hash.digest('hex'), fixture.sha256)
}

export async function verifyPersonalDriveUploads({ application, page, rpc, fixture, passed, setPhase, workspaceId, directory }) {
  const files = await mkdtemp(join(directory, 'personal-drive-'))
  try {
    setPhase('personal_drive_new_folder')
    // The previous scenario left the owner in this shared workspace. Both
    // people are members, so membership alone cannot explain the later denial.
    const location = new URL('mikka://app/mikka/en/')
    location.search = new URLSearchParams({ workspace: workspaceId, section: 'artifacts' }).toString()
    await page.goto(location.href, { waitUntil: 'domcontentloaded' })
    const folderName = 'Personal upload ' + randomUUID()
    await page.getByRole('button', { name: 'New folder', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New folder', exact: true })
    const folderInput = dialog.getByRole('textbox')
    await folderInput.fill(folderName)
    const volumes = '/mikka/api/drive/volumes'
    const [creation] = await Promise.all([
      page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === volumes),
      folderInput.press('Enter'),
    ])
    assert.equal(creation.status(), 201)
    const { volume } = await creation.json()
    assert.equal(volume.driveScope, 'user')
    assert.equal(volume.scopeId, fixture.ownerId)
    assert.equal(volume.name, folderName)
    const folder = page.getByText(new RegExp(folderName + '$'))
    const upload = page.getByRole('button', { name: 'Upload files', exact: true })
    // Some renderer versions open a newly created folder immediately.
    await expect(upload.or(folder).first()).toBeVisible()
    if (!await upload.isVisible()) await folder.click()
    const receipts = []
    const headPath = volumes + '/' + encodeURIComponent(volume.id)
    for (const size of [33, DRIVE_MAX_FILE_BYTES / MiB]) {
      setPhase('personal_drive_upload_' + size + '_MiB')
      const file = await createFixtureFile(files, size)
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), upload.click()])
      const [blob, published] = await Promise.all([
        page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === headPath + '/blobs', { timeout: 60_000 }),
        page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === headPath + '/entries', { timeout: 60_000 }),
        chooser.setFiles(file.path),
      ])
      assert.equal(blob.status(), 201)
      assert.deepEqual(await blob.json(), { sha256: file.sha256, sizeBytes: file.sizeBytes })
      assert.equal(published.status(), 200)
      const { headVersionId } = await published.json()
      assert.ok(isVolumeVersionId(headVersionId))
      await page.reload({ waitUntil: 'domcontentloaded' })
      // The folder selector may be local to the Artifact page. Reopen the
      // persisted folder when reloading takes the user to its directory.
      const visibleFile = page.getByText(file.name, { exact: true })
      await expect(visibleFile.or(folder).first()).toBeVisible()
      if (!await visibleFile.isVisible()) await folder.click()
      await expect(visibleFile).toBeVisible()
      await verifyDownloadedFile(application, page, file)
      receipts.push({ sizeBytes: file.sizeBytes, sha256: file.sha256, headVersionId })
      passed('packaged_personal_drive_' + size + '_MiB_uploaded_committed_and_downloaded_after_reload')
    }
    assert.notEqual(receipts[0].headVersionId, receipts[1].headVersionId)
    setPhase('personal_drive_same_workspace_member')
    await signInDesktopAccount(page, fixture.member, fixture.member.id)
    assert.ok((await rpc('workspace.switchWorkspace', [workspaceId])).ok)
    const peer = await page.evaluate(async ({ volumes, headPath, workspaceId, volumeId }) => {
      const workspace = '?workspaceId=' + encodeURIComponent(workspaceId)
      const listing = await fetch(volumes + workspace)
      const { volumes: personal } = await listing.json()
      const detail = await fetch(headPath + workspace)
      const file = await fetch(headPath + '/files' + workspace + '&path=personal-100MiB.bin')
      await file.body?.cancel()
      return { list: listing.status, present: personal.some(v => v.id === volumeId), head: detail.status, file: file.status }
    }, { volumes, headPath, workspaceId, volumeId: volume.id })
    assert.deepEqual(peer, { list: 200, present: false, head: 404, file: 404 })
    passed('packaged_personal_drive_same_workspace_member_cannot_list_or_read_owner_files')
    await signInDesktopAccount(page, fixture, fixture.ownerId)
    return receipts
  } finally { await rm(files, { recursive: true, force: true }) }
}
