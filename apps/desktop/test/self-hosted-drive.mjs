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

async function verifyDownloadedFile(application, page, fixture, receipt, stage) {
  // Playwright leaves Electron downloads under the OS's normal save-dialog
  // policy. Select the isolated destination on the actual DownloadItem.
  const destination = fixture.path + '.download'
  stage('start_download')
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
    receipt.downloadState = result.state
    receipt.downloadBytes = result.bytes
    assert.deepEqual(result, { state: 'completed', name: fixture.name, bytes: fixture.sizeBytes })
  } finally { await window.dispose() }
  stage('verify_downloaded_bytes')
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(destination)) {
    hash.update(chunk)
    size += chunk.length
  }
  assert.equal(size, fixture.sizeBytes)
  assert.equal(hash.digest('hex'), fixture.sha256)
  receipt.sha256 = fixture.sha256
}

async function readDriveDirectory(page, workspaceId, query = {}) {
  return page.evaluate(async ({ workspaceId, query }) => {
    const params = new URLSearchParams({ workspaceId, ...query })
    const response = await fetch('/mikka/api/drive/volumes?' + params, { cache: 'no-store' })
    if (!response.ok) throw new Error('Drive directory returned ' + response.status)
    return response.json()
  }, { workspaceId, query })
}

export async function verifyPersonalDriveUploads({ application, page, rpc, fixture, passed, setPhase, workspaceId, directory, folderCheck, receipts }) {
  const files = await mkdtemp(join(directory, 'personal-drive-'))
  try {
    setPhase('personal_drive_open_artifacts')
    // The previous scenario left the owner in this shared workspace. Both
    // people are members, so membership alone cannot explain the later denial.
    const location = new URL('mikka://app/mikka/en/')
    location.search = new URLSearchParams({ workspace: workspaceId, section: 'artifacts' }).toString()
    await page.goto(location.href, { waitUntil: 'domcontentloaded' })
    setPhase('personal_drive_project_scope_directory')
    const projectName = 'Desktop Files scope ' + randomUUID()
    const { project } = await rpc('projects.saveProject', [{
      workspaceId, name: projectName, description: '', summary: '', priority: 'normal', status: 'planned',
      lead: '', memberIds: [fixture.ownerId], startDate: '', targetDate: '',
    }])
    assert.ok(project?.id)
    const directoryMatches = await page.evaluate(async ({ workspaceId, projectId, projectName }) => {
      const query = new URLSearchParams({ workspaceId })
      const response = await fetch('/mikka/api/drive/scopes?' + query)
      if (!response.ok) return false
      const { scopes } = await response.json()
      return scopes.every(scope => scope.workspaceId === workspaceId)
        && scopes.some(scope => scope.driveScope === 'user')
        && scopes.some(scope => scope.driveScope === 'project-user' && scope.projectId === projectId && scope.name === projectName)
    }, { workspaceId, projectId: project.id, projectName })
    assert.equal(directoryMatches, true)
    passed('packaged_personal_drive_project_scope_directory_through_main_protocol')
    setPhase('shared_files_create_workspace_folder')
    const sharedName = 'Shared Desktop folder ' + randomUUID()
    const shared = await page.evaluate(async ({ workspaceId, projectId, name }) => {
      const team = new URLSearchParams({ workspaceId, driveScope: 'team-workspace' })
      const project = new URLSearchParams({ workspaceId, driveScope: 'project' })
      const readScopes = async params => {
        const response = await fetch('/mikka/api/drive/scopes?' + params)
        if (!response.ok) throw new Error('Drive destinations returned ' + response.status)
        return (await response.json()).scopes
      }
      const [teams, projects] = await Promise.all([readScopes(team), readScopes(project)])
      const create = await fetch('/mikka/api/drive/volumes?' + team, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
      })
      if (create.status !== 201) throw new Error('Create team folder returned ' + create.status)
      const { volume } = await create.json()
      return { teams, hasProject: projects.some(row => row.driveScope === 'project' && row.projectId === projectId),
        id: volume.id, scope: volume.driveScope, scopeId: volume.scopeId }
    }, { workspaceId, projectId: project.id, name: sharedName })
    assert.deepEqual(shared.teams, [{ workspaceId, driveScope: 'team-workspace' }])
    assert.equal(shared.hasProject, true)
    assert.equal(shared.scope, 'team-workspace')
    assert.equal(shared.scopeId, workspaceId)
    passed('packaged_shared_files_workspace_and_project_destinations_through_main_protocol')
    const folderName = 'Personal upload ' + randomUUID()
    const newFolder = page.getByRole('button', { name: 'New folder', exact: true }).filter({ visible: true })
    setPhase('personal_drive_open_folder_dialog')
    await newFolder.first().waitFor({ state: 'visible' })
    folderCheck.newFolderButtons = await newFolder.count()
    await newFolder.first().click()
    const dialog = page.getByRole('dialog', { name: 'New folder', exact: true })
    setPhase('personal_drive_name_folder')
    const folderInput = dialog.getByRole('textbox')
    await folderInput.fill(folderName)
    const volumes = '/mikka/api/drive/volumes'
    setPhase('personal_drive_submit_folder')
    const [creation] = await Promise.all([
      page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === volumes),
      dialog.getByRole('button', { name: 'Create', exact: true }).click(),
    ])
    folderCheck.createStatus = creation.status()
    folderCheck.workspaceMatched = new URL(creation.url()).searchParams.get('workspaceId') === workspaceId
    assert.equal(folderCheck.workspaceMatched, true)
    assert.equal(creation.status(), 201)
    const { volume } = await creation.json()
    assert.equal(volume.driveScope, 'user')
    assert.equal(volume.scopeId, fixture.ownerId)
    assert.equal(volume.name, folderName)
    setPhase('personal_drive_open_created_folder')
    const folder = page.getByText('My files · ' + folderName, { exact: true })
    const upload = page.getByRole('button', { name: 'Upload files', exact: true })
    // Some renderer versions open a newly created folder immediately.
    await expect(upload.or(folder).first()).toBeVisible()
    if (!await upload.isVisible()) await folder.click()
    await expect(upload).toBeVisible()
    passed('packaged_personal_drive_new_folder_committed_and_open')
    const headPath = volumes + '/' + encodeURIComponent(volume.id)
    for (const size of [33, DRIVE_MAX_FILE_BYTES / MiB]) {
      const stage = action => setPhase('personal_drive_' + size + '_MiB_' + action)
      const receipt = { sizeBytes: size * MiB }
      receipts.push(receipt)
      stage('create_fixture')
      const file = await createFixtureFile(files, size)
      stage('open_file_chooser')
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), upload.click()])
      stage('submit_upload')
      // Keep each observed status even when a later step fails or the head is never published.
      await Promise.all([
        page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === headPath + '/blobs', { timeout: 60_000 })
          .then(response => { receipt.blobStatus = response.status(); assert.equal(receipt.blobStatus, 201) }),
        page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === headPath + '/entries', { timeout: 60_000 })
          .then(response => { receipt.commitStatus = response.status(); assert.equal(receipt.commitStatus, 200) }),
        chooser.setFiles(file.path).then(() => { receipt.fileSelected = true }),
      ])
      stage('read_committed_manifest')
      // Chromium can evict the network-inspector entry for a large upload, including its
      // response body. The authenticated renderer reads the persisted version and file hash.
      const stored = await page.evaluate(async ({ path, name }) => {
        const response = await fetch(path, { cache: 'no-store' })
        if (!response.ok) return { status: response.status }
        const { head } = await response.json()
        return { status: response.status, version: head.headVersionId, entry: head.entries.find(item => item.path === name) }
      }, { path: headPath + '?workspaceId=' + encodeURIComponent(workspaceId), name: file.name })
      receipt.headStatus = stored.status
      assert.equal(stored.status, 200)
      assert.ok(isVolumeVersionId(stored.version))
      assert.deepEqual(stored.entry, { path: file.name, mode: 420, sha256: file.sha256, sizeBytes: file.sizeBytes })
      receipt.headVersionId = stored.version
      receipt.manifestVerified = true
      stage('reload_directory')
      await page.reload({ waitUntil: 'domcontentloaded' })
      // The folder selector may be local to the Artifact page. Reopen the
      // persisted folder when reloading takes the user to its directory.
      const visibleFile = page.getByText(file.name, { exact: true })
      stage('find_folder_or_file')
      await expect(visibleFile.or(folder).filter({ visible: true }).first()).toBeVisible()
      if (!await visibleFile.isVisible()) await folder.click()
      stage('find_reloaded_file')
      await expect(visibleFile).toBeVisible()
      await verifyDownloadedFile(application, page, file, receipt, stage)
      passed('packaged_personal_drive_' + size + '_MiB_uploaded_committed_and_downloaded_after_reload')
    }
    assert.notEqual(receipts[0].headVersionId, receipts[1].headVersionId)
    setPhase('personal_drive_select_skill_file')
    const skillName = 'desktop-guide-' + randomUUID()
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), upload.click()])
    const [committed] = await Promise.all([
      page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === headPath + '/entries'),
      chooser.setFiles({ name: 'SKILL.md', mimeType: 'text/markdown',
        buffer: Buffer.from(`---\nname: ${skillName}\ndescription: File guide\n---\nPrivate fixture instructions`) }),
    ])
    assert.equal(committed.status(), 200)
    const { headVersionId } = await committed.json()
    assert.ok(isVolumeVersionId(headVersionId))
    const ownerSkills = await readDriveDirectory(page, workspaceId, { view: 'skills' })
    assert.deepEqual(ownerSkills.skills.filter(skill => skill.volumeId === volume.id), [
      { volumeId: volume.id, path: 'SKILL.md', versionId: headVersionId, name: skillName, description: 'File guide' },
    ])
    passed('packaged_owner_uploads_skill_through_file_chooser_and_reads_current_metadata')
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
    setPhase('member_shared_files_and_own_skills')
    const [teamDirectory, ownSkills] = await Promise.all([
      readDriveDirectory(page, workspaceId, { driveScope: 'team-workspace' }),
      readDriveDirectory(page, workspaceId, { view: 'skills' }),
    ])
    assert.ok(teamDirectory.volumes.some(folder => folder.id === shared.id && folder.name === sharedName))
    assert.ok(ownSkills.skills.every(skill => skill.volumeId !== volume.id))
    passed('packaged_member_reads_shared_folder_and_separate_personal_skill_directory')
    await signInDesktopAccount(page, fixture, fixture.ownerId)
  } finally { await rm(files, { recursive: true, force: true }) }
}
