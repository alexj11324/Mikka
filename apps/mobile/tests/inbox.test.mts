import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createRequire } from 'node:module'
import React from 'react'
import { act, createElement, Fragment, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import type { InboxEntry, InboxPage } from '../../../lib/inbox/contract'
import { mobileMessages as messages } from '../lib/messages.ts'

const workspaceId = '10000000-0000-4000-8000-000000000001'
const run = '20000000-0000-4000-8000-000000000002'
const conversation: InboxEntry = { id: run, type: 'conversation', source: 'agent', title: 'Review the failed run', ownerId: 'owner',
  issueId: null, runId: run, pending: true, status: 'pending', occurredAt: '2026-11-14T00:00:00Z', rejectedAt: null, snoozedUntil: null, actions: ['open', 'dismiss'], reason: 'failed' }
const task: InboxEntry = { ...conversation, id: '30000000-0000-4000-8000-000000000003', type: 'task', title: 'Shared read-only task', reason: 'review', actions: ['open'] }
let dismissed = false, confirmed = true, scope = workspaceId, reloads = 0
const writes: unknown[] = [], navigation: string[] = [], reads: string[] = []
const noop = () => null
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
mock.module('expo-router', { namedExports: { useRouter: () => ({ push: (path: string) => navigation.push(path) }) } })
mock.module('react-native', { namedExports: { StyleSheet: { create: (s: unknown) => s }, View: 'div', RefreshControl: noop,
  FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent }: { data: { id: string }[]; renderItem: (row: unknown) => ReactNode; ListHeaderComponent: ReactNode; ListEmptyComponent: ReactNode }) =>
    createElement(Fragment, null, ListHeaderComponent, ...(data.length ? data.map(item => createElement('section', { key: item.id }, renderItem({ item }))) : [createElement(Fragment, { key: 'empty' }, ListEmptyComponent)])) } })
stub('components/NavBar.tsx', { NavBar: noop, underBar: {} })
stub('components/ReadNotice.tsx', { ReadNotice: noop })
stub('components/settings.tsx', { Row: ({ label, detail, onPress }: { label: string; detail: string; onPress: () => void }) => createElement('a', { onClick: onPress }, label, detail) })
stub('components/Text.tsx', { Text: ({ children }: { children: ReactNode }) => createElement('span', null, children) })
stub('components/GlassButton.tsx', { GlassButton: ({ label, onPress }: { label: string; onPress: () => void }) => createElement('button', { onClick: onPress }, label) })
stub('components/Segmented.tsx', { Segmented: ({ options, onChange }: { options: { value: string; label: string }[]; onChange: (value: string) => void }) =>
  createElement(Fragment, null, ...options.map(option => createElement('button', { key: option.value, onClick: () => onChange(option.value) }, option.label))) })
stub('lib/theme.ts', { colors: {}, LIST_INSET: 0 })
stub('lib/home.tsx', { useHome: () => ({ data: { workspace: { id: scope } } }) })
stub('lib/api-cache.ts', { apiCache: { context: () => 1 } })
stub('lib/api.ts', { ApiError: Error, api: async (path: string, input: { body: { action: string } }) => {
  writes.push({ path, input })
  if (!confirmed) return {}
  dismissed = input.body.action === 'dismiss'
  return { changed: true }
} })
stub('lib/useApi.ts', { useRefresh: () => ({}), useLiveApi: (path: string) => {
  reads.push(path)
  const done = new URL(path, 'http://localhost').searchParams.get('tab') === 'done'
  const items = done ? dismissed ? [{ ...conversation, status: 'done', actions: ['reopen'] }] : [] : dismissed ? [task] : [conversation, task]
  const data: InboxPage & { live: { workspaceId: string } } = { items: items as InboxEntry[], nextCursor: null, historySince: '', live: { workspaceId } }
  return { data, reloadAfterWrite: () => { reloads++ } }
} })
// Expo and the renderer use mobile React; Node resolves shared hooks from the repository root.
const sharedReact = createRequire(new URL('../../../lib/hooks/use-task-continuation.ts', import.meta.url)).resolve('react')
if (sharedReact !== createRequire(import.meta.url).resolve('react')) {
  mock.module(sharedReact, { defaultExport: React, namedExports: { useState: React.useState, useRef: React.useRef } })
}
const { default: Inbox } = await import('../app/inbox.tsx')

test('native Inbox opens a task-free conversation and dismisses and reopens only the authorized row', async () => {
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  const root = createRoot(host)
  const click = async (label: string) => {
    const node = [...host.querySelectorAll('button')].find(row => row.textContent === label)
    assert.ok(node, label)
    await act(async () => node.click())
  }
  try {
    await act(async () => root.render(createElement(Inbox)))
    assert.ok(host.textContent?.includes(messages.HostedInbox.reason.failed))
    assert.equal(host.querySelectorAll('section button').length, 1)
    await act(async () => host.querySelector('a')!.click())
    assert.deepEqual(navigation, ['/thread/' + run])
    await click(messages.HostedInbox.dismiss)
    assert.equal(host.textContent?.includes(conversation.title), false)
    await click(messages.HostedInbox.done)
    assert.ok(host.textContent?.includes(conversation.title))
    await click(messages.HostedInbox.reopen)
    for (const [index, action] of ['dismiss', 'reopen'].entries()) {
      assert.deepEqual(writes[index], { path: '/api/inbox', input: { method: 'POST', body: { workspaceId, id: run, type: 'conversation', action } } })
    }
    assert.equal(reloads, 2)
    await click(messages.HostedInbox.waitingOnYou)
    confirmed = false
    await click(messages.HostedInbox.dismiss)
    assert.ok(host.textContent?.includes(messages.HostedInbox.writeError))
    assert.ok(host.textContent?.includes(conversation.title))
    scope = 'other-workspace'
    await act(async () => root.render(createElement(Inbox)))
    assert.equal(host.querySelectorAll('section').length, 0)
    assert.ok(reads.at(-1)?.includes('workspaceId=other-workspace'))
  } finally { await act(async () => root.unmount()); await browser.happyDOM.close() }
})
