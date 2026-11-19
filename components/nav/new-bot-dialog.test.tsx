import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { NewBotProps } from '../slots/new-bot-contract'
import type { BotModelMenu } from '../../lib/bot-model-menu-view'

// Source contract of the New Bot controller in Node, not a browser acceptance test: what it reads, when, and what it saves.
let props: NewBotProps | null = null
mock.module(new URL('../slots/new-bot.tsx', import.meta.url).href, { namedExports: {
  NewBot: (next: NewBotProps) => { props = next; return null },
} })
mock.module(new URL('../slots/bot-avatar.tsx', import.meta.url).href, { namedExports: { BotAvatar: () => null } })
mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: (namespace: string) => Object.assign((key: string) => `${namespace}.${key}`, { has: () => false }) } })
mock.module('sonner', { namedExports: { toast: { error: (text: string) => { toasts.push(text) }, success: () => {} } } })

const selectedScopes: (string | undefined)[] = []
const calls: string[] = []
const toasts: string[] = []
const created: Record<string, unknown>[] = []
const chosen: [string | null, string][] = []
let defaultsResult: { error?: string; defaultModel?: null; defaultRepository?: string | null; models?: string[]; repositories?: string[] }
let menu: BotModelMenu
let failChoose = false
mock.module(new URL('../../app/actions/bots.ts', import.meta.url).href, { namedExports: {
  getWorkspaceBotDefaults: async (workspaceId?: string) => { selectedScopes.push(workspaceId); calls.push('defaults'); return defaultsResult },
  createBot: async (input: Record<string, unknown>, workspaceId?: string) => { selectedScopes.push(workspaceId); created.push(input); return { id: 'new-bot', name: input.name, color: input.color, shape: input.shape } },
} })
mock.module(new URL('../../app/actions/execution-settings.ts', import.meta.url).href, { namedExports: {
  getBotModelMenu: async (bot: string | null, workspaceId?: string) => { selectedScopes.push(workspaceId); calls.push(`menu:${bot}`); return menu },
  refreshBotModelMenuAction: async () => menu,
  chooseBotModel: async (bot: string | null, id: string) => { chosen.push([bot, id]); return failChoose ? { error: 'botNotFound' } : menu },
} })

const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let SWRConfig: typeof import('swr')['SWRConfig']
let NewBotDialog: typeof import('./new-bot-dialog')['NewBotDialog']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig } = await import('swr'))
  ;({ NewBotDialog } = await import('./new-bot-dialog'))
})
beforeEach(() => {
  props = null; failChoose = false; selectedScopes.length = 0; calls.length = 0; toasts.length = 0; created.length = 0; chosen.length = 0
  defaultsResult = { defaultModel: null, defaultRepository: 'acme/app', models: [], repositories: ['acme/app', 'acme/web'] }
  menu = {
    groups: [{ kind: 'subscription', provider: 'claude', credentialLabel: 'Work', options: [
      { id: 'binding-haiku', modelId: 'claude-haiku-5-5', provider: 'claude' },
      { id: 'binding-sonnet', modelId: 'claude-sonnet-5-5', provider: 'claude' },
    ] }],
    current: { id: 'binding-haiku', modelId: 'claude-haiku-5-5', provider: 'claude', kind: 'subscription', chosen: false, available: true, availability: 'available' },
  } as BotModelMenu
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
// A fresh cache per test, as a newly opened window has.
const render = async (node: ReactNode) => { await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>)) }
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const dialog = (open: boolean, onCreated: () => void = () => {}, workspaceId?: string) => <NewBotDialog open={open} workspaceId={workspaceId} onOpenChange={() => {}} onCreated={onCreated} />

test('a closed window sends no request', async () => {
  await render(dialog(false))
  await settle()
  assert.deepEqual(calls, [])
  assert.equal(props, null)
})

test('opening reads the model menu and the workspace defaults once, and shows the default repository', async () => {
  await render(dialog(true))
  await settle()
  assert.deepEqual(calls.sort(), ['defaults', 'menu:null'])
  assert.equal(props!.repository.value, 'acme/app')
  assert.equal(props!.repository.disabled, false)
  assert.deepEqual(props!.repository.choices.map(choice => choice.value), ['', 'acme/app', 'acme/web'])
  assert.equal(props!.model.value, 'binding-haiku')
})

test('a failed defaults read leaves the 仓库 row usable as text and the Bot on the workspace default', async () => {
  defaultsResult = { error: 'workspaceAccessDenied' }
  await render(dialog(true))
  await settle()
  assert.equal(props!.repository.disabled, true)
  assert.equal(props!.repository.value, null)
  assert.equal(props!.repository.label, 'Coordinator.modelPicker.unavailable', 'never claims 不用仓库')
  await act(async () => props!.onName('Builder'))
  await act(async () => props!.onSubmit())
  assert.equal(created.length, 1)
  assert.equal('repository' in created[0], false, 'createBot applies the workspace default itself')
})

test('a picked model and repository are saved on the new Bot', async () => {
  let opened = ''
  await render(dialog(true, () => { opened = 'new-bot' }, 'shown-team'))
  await settle()
  await act(async () => { props!.onName('Builder'); props!.model.onChange('binding-sonnet'); props!.repository.onChange('') })
  await act(async () => props!.onSubmit())
  assert.deepEqual(created[0], { name: 'Builder', color: created[0].color, shape: created[0].shape, repository: null })
  assert.deepEqual(chosen, [['new-bot', 'binding-sonnet']])
  assert.equal(opened, 'new-bot')
  assert.deepEqual(selectedScopes, ['shown-team', 'shown-team', 'shown-team'])
})

test('without a pick, only a model the Coordinator chose is pinned; an unchosen default is left to the resolver', async () => {
  await render(dialog(true))
  await settle()
  await act(async () => props!.onName('Builder'))
  await act(async () => props!.onSubmit())
  assert.deepEqual(chosen, [], 'the default the row shows is what the new Bot resolves to')
  await act(async () => root.render(null))
  menu = { ...menu, current: { ...menu.current, id: 'binding-sonnet', modelId: 'claude-sonnet-5-5', chosen: true } } as BotModelMenu
  await render(dialog(true))
  await settle()
  await act(async () => props!.onName('Second'))
  await act(async () => props!.onSubmit())
  assert.deepEqual(chosen, [['new-bot', 'binding-sonnet']], 'the model the row showed is the model stored')
})

test('a model that did not save still creates the Bot and says so', async () => {
  failChoose = true
  let opened = ''
  await render(dialog(true, () => { opened = 'new-bot' }))
  await settle()
  await act(async () => { props!.onName('Builder'); props!.model.onChange('binding-sonnet') })
  await act(async () => props!.onSubmit())
  assert.equal(created.length, 1)
  assert.deepEqual(toasts, ['Coordinator.modelPicker.notSaved'])
  assert.equal(opened, 'new-bot')
})
