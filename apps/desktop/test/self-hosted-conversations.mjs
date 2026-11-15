import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { waitForBundledSession } from './bundled-session.mjs'

const english = JSON.parse(await readFile(new URL('../../../messages/en.json', import.meta.url), 'utf8'))
const words = english.ConversationDirectory

// These are ordinary renderer HTTP requests. The packaged app supplies the
// authenticated account and selected workspace through the existing broker.
async function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const res = await fetch('/mikka/api/' + path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: res.status, data: await res.json() }
  }, { path, body })
}

async function signIn(page, email, password, id) {
  await page.evaluate(() => window.mikka.bundled.signOut())
  assert.equal(await page.evaluate(() => window.mikka.bundled.session()), null)
  assert.equal(await page.evaluate(account => window.mikka.bundled.signInEmail(account), { email, password }), null)
  await waitForBundledSession(page, id)
}

async function selectWorkspace(page, rpc, workspaceId, userId, role) {
  const switched = await rpc('workspace.switchWorkspace', [workspaceId])
  assert.ok(switched.ok)
  const { status, data } = await api(page, 'workspace')
  assert.equal(status, 200)
  assert.equal(data.workspace.id, workspaceId)
  assert.equal(data.currentUserId, userId)
  assert.equal(data.role, role)
}

export async function verifyConversationOrganization({ page, fixture, rpc, passed, setPhase,
  baseUrl = 'mikka://app/mikka/en/', signInAs = (account, id) => signIn(page, account.email, account.password, id) }) {
  setPhase('conversation_owner_setup')
  const suffix = randomUUID()
  const created = await rpc('workspace.createWorkspace', [{ name: 'Desktop conversation QA', slug: 'desktop-' + suffix }])
  assert.ok(created.ok)
  const { workspaceId } = created.data
  await selectWorkspace(page, rpc, workspaceId, fixture.ownerId, 'admin')
  const invited = await rpc('workspace.createWorkspaceInvitation', [{ workspaceId, emails: [fixture.member.email], role: 'member' }])
  assert.ok(invited.ok)
  const invitation = /^\/invite\/([a-f0-9]{64})$/.exec(invited.data[0]?.path)?.[1]
  assert.ok(invitation)
  const bot = await api(page, 'bots', { name: 'Desktop conversation QA' })
  assert.equal(bot.status, 201)
  assert.equal(bot.data.workspaceId, workspaceId)
  const firstTitle = 'Desktop thread ' + suffix
  const title = 'Renamed desktop thread ' + suffix
  const named = await api(page, 'conversations', { workspaceId, purpose: 'conversation', title: firstTitle,
    members: [{ memberType: 'bot', memberId: bot.data.id }], leadBotId: bot.data.id })
  assert.equal(named.status, 201)
  const target = { kind: 'chat', id: named.data.id }
  assert.ok(target.id && named.data.title === firstTitle)
  const location = new URL(baseUrl)
  location.searchParams.set('workspace', workspaceId)
  const open = async params => {
    const url = new URL(location)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    await page.goto(url.href, { waitUntil: 'domcontentloaded' })
  }
  const directory = async (search, archived = false) => {
    const result = await rpc('task-runs.listConversations', [{ search, archived }])
    return result.items.find(item => item.kind === target.kind && item.id === target.id)
  }
  const heading = name => page.getByRole('heading', { level: 2, name, exact: true })
  const menuItem = async (name, item) => {
    const header = page.locator('header:visible').filter({ has: heading(name) })
    await header.getByRole('button', { name: english.Shell.panel.task.more, exact: true }).click()
    await page.getByRole('button', { name: item, exact: true }).filter({ visible: true }).click()
  }
  setPhase('conversation_title_reload')
  await open({ group: target.id })
  await menuItem(firstTitle, english.IssueThreads.threadTitle.rename)
  const dialog = page.getByRole('dialog', { name: english.IssueThreads.threadTitle.rename })
  await dialog.getByRole('textbox').fill(title)
  await dialog.getByRole('button', { name: english.Common.save, exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await directory(title))?.title).toBe(title)
  await page.reload()
  await expect(heading(title).first()).toBeVisible()
  passed('named_conversation_manual_title_persisted_after_reload')
  setPhase('conversation_pin_and_archive')
  const organization = english.IssueThreads.organization
  const flags = () => rpc('task-runs.readConversationOrganization', [target])
  for (const [field, enable, disable] of [['pinned', organization.pin, organization.unpin], ['archived', organization.archive, organization.unarchive]]) {
    await menuItem(title, enable)
    await expect.poll(async () => (await flags())?.[field]).toBe(true)
    if (field === 'archived') {
      assert.equal(await directory(title), undefined)
      assert.equal((await directory(title, true))?.id, target.id)
    } else {
      assert.equal((await directory(title))?.pinned, true)
    }
    await open({ group: target.id })
    await menuItem(title, disable)
    await expect.poll(async () => (await flags())?.[field]).toBe(false)
    assert.equal((await directory(title))?.id, target.id)
  }
  passed('named_conversation_pin_unpin_archive_restore_after_reopen')
  setPhase('conversation_unread_persistence')
  await open({ section: 'conversations' })
  const region = page.getByRole('region', { name: words.title, exact: true })
  const row = region.getByRole('listitem').filter({ hasText: title })
  await row.getByRole('button', { name: words.markUnread, exact: true }).click()
  await expect.poll(async () => (await directory(title))?.unread).toBe(true)
  await page.reload()
  await expect(row.getByRole('img', { name: words.unread })).toBeVisible()
  passed('owner_manual_unread_persisted_in_directory_across_reload')
  setPhase('conversation_member_authorization')
  await signInAs(fixture.member, fixture.member.id)
  assert.ok((await rpc('workspace.acceptWorkspaceInvitation', [invitation])).ok)
  await selectWorkspace(page, rpc, workspaceId, fixture.member.id, 'member')
  assert.equal(await directory(title), undefined)
  assert.equal((await api(page, 'conversations/' + target.id + '/messages')).status, 404)
  assert.equal((await api(page, 'conversations/read-state', { action: 'unread', chatId: target.id })).status, 404)
  assert.equal(await rpc('task-runs.readConversationOrganization', [target]), null)
  assert.equal(await rpc('task-runs.setConversationOrganization', [target, { field: 'archived', value: true }]), null)
  passed('independently_signed_in_same_workspace_member_cannot_discover_read_or_organize_owner_chat')
  setPhase('conversation_owner_readback')
  await signInAs(fixture, fixture.ownerId)
  await selectWorkspace(page, rpc, workspaceId, fixture.ownerId, 'admin')
  assert.deepEqual(await flags(), { archived: false, pinned: false })
  assert.equal((await directory(title))?.unread, true)
  await open({ section: 'conversations' })
  await region.getByRole('button', { name: words.readAll, exact: true }).click()
  await expect.poll(async () => (await directory(title))?.unread).toBe(false)
  await page.reload()
  await expect(row.getByRole('button', { name: words.markUnread, exact: true })).toBeVisible()
  passed('returned_owner_preserves_title_and_clears_unread_with_durable_readback')
}
