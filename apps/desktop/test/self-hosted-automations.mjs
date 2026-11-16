import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, request } from '@playwright/test'
import { decode } from '../../../lib/desktop-rpc/wire.ts'
import { signInDesktopAccount } from './self-hosted-conversations.mjs'

const { Automations: words, Onboarding: onboarding } = JSON.parse(await readFile(new URL('../../../messages/en.json', import.meta.url), 'utf8'))

// Keep the member's packaged editor open while the existing workspace admin writes from a separate web session.
async function verifyConcurrentDraft({ page, workspaceId, fixture, rpc, passed, setPhase, location }) {
  const view = id => rpc('automations.getAutomation', [id, workspaceId]).then(result => result.automation)
  const editor = words.editor
  const title = 'Concurrent schedule ' + randomUUID()
  const name = page.getByRole('textbox', { name: editor.name, exact: true })
  const save = page.getByRole('button', { name: editor.save, exact: true })
  const discard = page.getByRole('button', { name: editor.loadSavedVersion, exact: true })

  setPhase('automation_member_creates_independent_draft')
  const created = await rpc('automations.createAutomation', [{
    requestId: randomUUID(),
    definition: { title, timezone: 'UTC', timing: { kind: 'manual' }, misfire: 'skip', maxLatenessMinutes: 30,
      task: { kind: 'dispatch_task', botId: null, prompt: 'Disposable concurrent edit' } },
  }, workspaceId])
  assert.ok(created.schedule?.id)
  const id = created.schedule.id
  const url = new URL(location)
  url.searchParams.set('automation', id)
  await page.goto(url.href, { waitUntil: 'domcontentloaded' })
  await expect(name).toHaveValue(title)
  await expect(name).toBeEditable()
  assert.equal((await view(id)).owner_id, fixture.member.id)

  // validateSelfHostedDesktopTarget has already pinned this origin and both disposable identities.
  const admin = await request.newContext({ baseURL: fixture.origin, maxRedirects: 0,
    extraHTTPHeaders: { origin: fixture.origin, 'x-mikka-rpc': '1' } })
  let signedIn = false
  async function adminAction(action, args) {
    const response = await admin.post('/mikka/api/rpc', { data: { version: 1, action, args } })
    assert.equal(response.status(), 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    return decode(body.result)
  }
  async function rename(automation, nextTitle) {
    const result = await adminAction('automations.updateAutomation', [{ scheduleId: id, version: automation.version,
      definition: { ...automation.definition, title: nextTitle } }, workspaceId])
    assert.equal(result.schedule?.version, automation.version + 1)
    return result.schedule
  }
  try {
    setPhase('automation_concurrent_admin_sign_in')
    const login = await admin.post('/mikka/api/auth/sign-in/email', { data: {
      email: fixture.email, password: fixture.password, rememberMe: false,
    } })
    assert.equal(login.status(), 200)
    signedIn = true
    assert.ok((await adminAction('workspace.switchWorkspace', [workspaceId])).ok)
    const session = await adminAction('desktop.bootstrap', [workspaceId])
    assert.equal(session.user.id, fixture.ownerId)
    assert.deepEqual(session.cacheWorkspace, { workspaceId, role: 'admin' })

    setPhase('automation_hold_member_draft_on_admin_save')
    const local = title + ' unsaved'
    const remote = title + ' admin update'
    await name.fill(local)
    await expect(name).toHaveValue(local)
    const original = await view(id)
    await rename(original, remote)
    await expect(discard).toBeVisible()
    await expect(name).toHaveValue(local)
    await expect(save).toBeDisabled()
    assert.equal((await view(id)).definition.title, remote)
    passed('packaged_member_automation_draft_survives_an_independent_admin_save')

    setPhase('automation_discard_and_save_current_revision')
    await discard.click()
    await expect(discard).toHaveCount(0)
    await expect(name).toHaveValue(remote)
    const revised = title + ' member revision'
    await name.fill(revised)
    await save.click()
    await expect(page.getByText(editor.saved, { exact: true })).toBeVisible()
    const saved = await view(id)
    assert.equal(saved.definition.title, revised)
    assert.equal(saved.version, original.version + 2)
    const finalTitle = title + ' clean update'
    await rename(saved, finalTitle)
    await expect(name).toHaveValue(finalTitle)
    await expect(discard).toHaveCount(0)
    assert.equal((await view(id)).next_at, null)
    assert.deepEqual((await rpc('automations.automationHistory', [id, workspaceId])).occurrences, [])
    passed('packaged_member_loads_saved_revision_edits_and_follows_the_next_clean_update')
  } finally {
    try {
      if (signedIn) assert.equal((await admin.post('/mikka/api/auth/sign-out', { data: {} })).status(), 200)
    } finally { await admin.dispose() }
  }
}

/** Exercise the installed renderer's normal Automations controls with a manual-only schedule. */
export async function verifyWorkspaceAutomation({ page, workspaceId, fixture, rpc, passed, setPhase,
  baseUrl = 'mikka://app/mikka/en/', signInAs = (account, id) => signInDesktopAccount(page, account, id) }) {
  const location = new URL(baseUrl)
  location.searchParams.set('workspace', workspaceId)
  location.searchParams.set('section', 'automations')
  const title = 'Desktop schedule ' + randomUUID()
  const name = page.getByRole('textbox', { name: words.editor.name, exact: true })
  const collection = page.getByRole('region', { name: words.title, exact: true })
  const status = page.getByRole('switch', { name: words.editor.enabled, exact: true })
  const row = collection.getByRole('listitem').filter({ hasText: title })
  const read = id => rpc('automations.getAutomation', [id, workspaceId])

  setPhase('automation_open_workspace_list')
  assert.ok((await rpc('workspace.switchWorkspace', [workspaceId])).ok)
  await page.goto(location.href, { waitUntil: 'domcontentloaded' })
  await collection.getByText(words.filter.deleted, { exact: true }).click()
  await expect(collection.getByText(words.emptyDeleted, { exact: true })).toBeVisible()
  await collection.getByText(words.filter.all, { exact: true }).click()
  await collection.locator('header').getByRole('button', { name: words.new, exact: true }).click()
  await page.getByRole('menuitem', { name: words.fromScratch, exact: true }).click()
  setPhase('automation_create_manual_only')
  await name.fill(title)
  await page.getByRole('textbox', { name: words.editor.prompt, exact: true }).fill('Disposable scheduled task')
  const timed = page.getByRole('switch', { name: words.editor.schedule, exact: true })
  await expect(timed).toBeChecked()
  await timed.click()
  await expect(timed).not.toBeChecked()
  await page.getByRole('button', { name: words.editor.create, exact: true }).click()
  await page.waitForURL(url => /^[a-f\d-]{36}$/i.test(url.searchParams.get('automation') ?? ''))
  const scheduleId = new URL(page.url()).searchParams.get('automation')
  const { automation: created } = await read(scheduleId)
  assert.equal(created.owner_id, fixture.ownerId)
  assert.equal(created.workspace_id, workspaceId)
  assert.equal(created.definition.title, title)
  assert.equal(created.definition.timing.kind, 'manual')
  assert.equal(created.next_at, null)
  passed('packaged_manual_automation_created_in_shown_workspace')

  // The editor's return button and the workspace sidebar both use the translated Automations title.
  const back = page.getByRole('region', { name: words.editor.back, exact: true })
    .getByRole('button', { name: words.editor.back, exact: true })
  setPhase('automation_return_from_created_editor')
  await back.click()
  await page.waitForURL(url => !url.searchParams.has('automation') && url.searchParams.get('section') === 'automations')
  setPhase('automation_find_created_row_in_warm_list')
  await expect(row).toHaveCount(1)
  setPhase('automation_open_created_row_from_warm_list')
  await row.getByText(title, { exact: true }).click()
  await page.waitForURL(url => url.searchParams.get('automation') === scheduleId)
  setPhase('automation_read_reopened_editor_title')
  await expect(name).toHaveValue(title)

  setPhase('automation_pause_delete_restore')
  await expect(status).toBeChecked()
  await status.click()
  await expect(status).not.toBeChecked()
  assert.equal((await read(scheduleId)).automation.status, 'paused')
  await back.click()
  await collection.getByRole('button', { name: words.filter.paused, exact: true }).click()
  await row.getByText(title, { exact: true }).click()
  await expect(status).not.toBeChecked()
  setPhase('automation_delete_paused_schedule')
  await page.getByRole('button', { name: words.editor.delete, exact: true }).click()
  await page.getByRole('alertdialog', { name: words.editor.deleteTitle, exact: true })
    .getByRole('button', { name: words.editor.delete, exact: true }).click()
  setPhase('automation_open_deleted_filter')
  await collection.getByText(words.filter.deleted, { exact: true }).click()
  setPhase('automation_restore_schedule')
  await row.getByRole('button', { name: words.restore, exact: true }).click()
  await expect(row).toHaveCount(0)
  setPhase('automation_open_restored_schedule')
  await collection.getByText(words.filter.all, { exact: true }).click()
  await row.getByText(title, { exact: true }).click()
  await expect(name).toHaveValue(title)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(name).toHaveValue(title)
  await expect(status).not.toBeChecked()
  const { automation: restored } = await read(scheduleId)
  assert.equal(restored.id, scheduleId)
  assert.equal(restored.status, 'paused')
  assert.equal(restored.deleted, false)
  assert.equal(restored.next_at, null)
  setPhase('automation_verify_restored_history')
  const history = await rpc('automations.automationHistory', [scheduleId, workspaceId])
  assert.deepEqual(history.occurrences, [])
  passed('packaged_paused_automation_deleted_restored_and_reopened_without_a_run')

  setPhase('automation_sign_in_independent_member')
  await signInAs(fixture.member, fixture.member.id)
  setPhase('automation_select_member_workspace')
  assert.ok((await rpc('workspace.switchWorkspace', [workspaceId])).ok)
  const memberBootstrap = await rpc('desktop.bootstrap', [workspaceId])
  assert.equal(memberBootstrap.user.id, fixture.member.id)
  assert.deepEqual(memberBootstrap.cacheWorkspace, { workspaceId, role: 'member' })
  await page.goto(location.href, { waitUntil: 'domcontentloaded' })
  if (memberBootstrap.onboarding) {
    // Previous checks for this account read through the broker without opening its first-run screen.
    setPhase('automation_member_first_run_skip')
    const skip = page.getByRole('button', { name: onboarding.skip, exact: true })
    await skip.click()
    await expect(skip).toBeHidden()
    assert.equal((await rpc('desktop.bootstrap', [workspaceId])).onboarding, false)
    await page.goto(location.href, { waitUntil: 'domcontentloaded' })
  }
  setPhase('automation_member_find_restored_row')
  assert.equal((await read(scheduleId)).automation.owner_id, fixture.ownerId)
  await expect(row).toHaveCount(1)
  setPhase('automation_member_open_restored_row')
  await row.getByText(title, { exact: true }).click()
  await page.waitForURL(url => url.searchParams.get('automation') === scheduleId)
  setPhase('automation_member_read_restored_detail')
  await expect(name).toHaveValue(title)
  await expect(status).not.toBeChecked()
  setPhase('automation_member_role_controls')
  await expect(name).not.toBeEditable()
  await expect(status).toBeDisabled()
  await expect(page.getByRole('button', { name: words.editor.resume, exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: words.editor.save, exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: words.editor.delete, exact: true })).toBeEnabled()
  passed('packaged_same_workspace_member_reads_the_restored_owner_automation')
  passed('packaged_member_retains_delete_without_edit_or_resume_on_a_different_creator_schedule')
  await verifyConcurrentDraft({ page, workspaceId, fixture, rpc, passed, setPhase, location })
  await signInAs(fixture, fixture.ownerId)
  assert.ok((await rpc('workspace.switchWorkspace', [workspaceId])).ok)
}
