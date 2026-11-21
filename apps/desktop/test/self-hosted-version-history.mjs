import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'

const { IssueThreads: words } = JSON.parse(await readFile(new URL('../../../messages/en.json', import.meta.url), 'utf8'))

export async function verifyDesktopVersionHistory({ page, rpc, fixture, passed, setPhase }) {
  assert.deepEqual(fixture.versionHistory.map(item => item.operation), ['edit', 'rerun'])
  assert.equal((await rpc('workspace.switchWorkspace', [fixture.workspaceId])).ok, true)
  const receipts = []
  for (const original of fixture.versionHistory) {
    const { operation, issueId, runId, anchorKey, originalText, originalOutput, originalPullRequest } = original
    setPhase('conversation_version_' + operation)
    const title = operation === 'edit' ? words.versionEdit : words.versionRerun
    const address = new URL('mikka://app/mikka/en/')
    address.search = new URLSearchParams({ workspace: fixture.workspaceId, issue: issueId, thread: runId }).toString()
    const open = async () => {
      const text = operation === 'edit' ? originalText : originalOutput
      const source = page.getByText(text, { exact: true }).filter({ visible: true })
      await expect(source).toHaveCount(1)
      await source.hover()
      // After an edit the continuation has an Edit button of its own.
      // Locate the original message's nearest action group without assuming
      // any private component class, test ID or position in the transcript.
      const group = source.locator(`xpath=ancestor::*[.//button[normalize-space(.)=${JSON.stringify(title)}]][1]`)
      const control = group.getByRole('button', { name: title, exact: true })
      await expect(control).toHaveCount(1)
      await control.click()
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      if (operation === 'edit') await expect(dialog.getByRole('textbox', { name: title })).toHaveValue(originalText)
      else await expect(dialog.getByText(originalOutput, { exact: true })).toBeVisible()
      return dialog
    }
    const history = () => rpc('agents.getThreadReplyVersions', [issueId,runId])
    assert.deepEqual(await history(), [])
    await page.goto(address.href, { waitUntil: 'domcontentloaded' })
    let dialog = await open()
    const updated = originalText + ' with a revision'
    if (operation === 'edit') await dialog.getByRole('textbox', {name: title}).fill(updated)
    const writer = page.waitForResponse(response => {
      const request = response.request()
      return new URL(response.url()).pathname.endsWith('/api/desktop/rpc') && request.method() === 'POST'
        && request.postDataJSON()?.action === 'agents.createThreadReplyVersion'
    })
    const [response] = await Promise.all([writer, dialog.getByRole('button', {name: words.versionRun, exact: true}).click()])
    const command = response.request().postDataJSON().args[0]
    assert.equal(command.issueId, issueId)
    assert.equal(command.runId, runId)
    assert.equal(command.change.operation, operation)
    assert.equal(command.change.anchorRunId, runId)
    assert.equal(command.change.anchorKey, anchorKey)
    assert.match(command.change.requestId, /^[a-f0-9-]{36}$/i)
    assert.equal(response.status(), 200)
    const ack = await response.json()
    assert.equal(ack.ok, true)
    const {versionId, runId: resultRunId} = ack.result
    assert.ok(versionId && resultRunId && resultRunId !== runId)
    const chosen = dialog.getByRole('combobox', {name:words.versionHistory})
    await expect(chosen).toHaveValue(versionId)
    const rows = await history()
    assert.equal(rows.length, 1)
    const [row] = rows
    assert.deepEqual([row.id,row.anchorRunId,row.anchorKey,row.resultRunId], [versionId,runId,anchorKey,resultRunId])
    assert.equal(row.text, operation === 'edit' ? updated : originalText)
    assert.equal(row.originalOutput, originalOutput)
    assert.equal(row.originalPullRequest, originalPullRequest)
    // The write may advance navigation to the newly admitted Run. Reopen the
    // original deep link as a fresh document, never as the active attempt.
    if (page.url() === address.href) await page.reload({ waitUntil: 'domcontentloaded' })
    else await page.goto(address.href, { waitUntil: 'domcontentloaded' })
    dialog = await open()
    const select = dialog.getByRole('combobox', {name:words.versionHistory})
    await select.selectOption(versionId)
    await expect(select).toHaveValue(versionId)
    await select.selectOption('original')
    await expect(dialog.getByText(originalOutput, {exact:true})).toBeVisible()
    await expect(dialog.getByRole('link', {name:words.versionPullRequest})).toHaveAttribute('href',originalPullRequest)
    assert.deepEqual(await history(), rows)
    receipts.push({operation,issueId,runId,versionId,resultRunId})
    passed('packaged_' + operation + '_created_one_version_and_reopened_original_publication')
  }
  return receipts
}
