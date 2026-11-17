import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

/** Public trusted-build acceptance. The disposable root is verified in memory.
 * Only a digest of a path-masked dialog and positive operation counts leave it. */
export async function verifyInstalledProjectCheckout({ page, rpc, workspaceId, root, choose }) {
  const name = 'Desktop checkout QA'
  const { project } = await rpc('projects.saveProject', [{ workspaceId, name, summary: '', description: '',
    status: 'planned', priority: 'none', lead: '', startDate: '', targetDate: '' }])
  assert.ok(project?.id && project.workspaceId === workspaceId)
  try {
    const document = new URL('mikka://app/mikka/en/')
    document.search = new URLSearchParams({ workspace: workspaceId, section: 'projects', project: project.id }).toString()
    const open = async () => {
      await page.goto(document.href, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: 'My local folders', exact: true }).click()
    }
    await open()
    const dialog = page.getByRole('dialog')
    const select = dialog.getByRole('button', { name: 'Choose a Git folder', exact: true })
    const connect = dialog.getByRole('button', { name: 'Connect this computer', exact: true })
    await connect.or(select).waitFor({ state: 'visible' })
    if (await connect.isVisible()) await connect.click()
    await select.waitFor({ state: 'visible' })
    await choose(() => select.click())
    const folder = dialog.getByText(root, { exact: true })
    await folder.waitFor({ state: 'visible' })
    await open()
    await folder.waitFor({ state: 'visible' })
    const screenshot = await dialog.screenshot({ animations: 'disabled', mask: [folder] })
    await dialog.getByRole('button', { name: /^Remove folder on / }).click()
    await dialog.getByText('No folder selected.', { exact: true }).waitFor({ state: 'visible' })
    await open()
    await dialog.getByText('No folder selected.', { exact: true }).waitFor({ state: 'visible' })
    return { nativeSelection: true, persistedAfterReload: true, emptyAfterReload: true,
      maskedDialogSha256: createHash('sha256').update(screenshot).digest('hex') }
  } finally {
    const deleted = await rpc('projects.deleteProject', [{ workspaceId, id: project.id, revision: project.revision, confirmation: name }])
    assert.equal(deleted.error, undefined)
  }
}
