import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createContext, useContext, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { AgentProfilesView } from '../settings/factory-profiles-data'
import type { CoordinatorMessageContext } from './use-coordinator-submit'

// Source component contracts in Node, not a browser acceptance test. The
// existing Select primitive is reduced to its value/disabled/onChange contract.
const Selection = createContext<{ pick?: (value: string) => void; disabled?: boolean }>({})
const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>
let Button: typeof import('../ui/button')['Button']
let Input: typeof import('../ui/input')['Input']
mock.module(new URL('../ui/select.tsx', import.meta.url).href, { namedExports: {
  Select: ({ children, onValueChange, disabled }: { children: ReactNode; onValueChange?: (value: string) => void; disabled?: boolean }) =>
    <Selection.Provider value={{ pick: onValueChange, disabled }}>{children}</Selection.Provider>,
  SelectItem: ({ children, value, disabled }: { children: ReactNode; value: string; disabled?: boolean }) => {
    const parent = useContext(Selection)
    return <Button type="button" data-option={value} disabled={disabled || parent.disabled} onClick={() => parent.pick?.(value)}>{children}</Button>
  },
  SelectContent: Wrap, SelectGroup: Wrap, SelectLabel: Wrap, SelectSeparator: () => null, SelectTrigger: Wrap, SelectValue: () => null,
} })
// Check the controller's inputs and callbacks without requiring the private renderer.
mock.module(new URL('../slots/new-task.tsx', import.meta.url).href, { namedExports: {
  NewTask: (props: import('../slots/new-task-contract').NewTaskProps) => <>
    <Input id="new-task-name" value={props.title} maxLength={props.titleMax} onChange={event => props.onTitle(event.target.value)} />
    {props.notices}
    {props.intent !== 'create_only' && props.profile.choices.map(choice => <Button key={choice.value} data-option={choice.value}
      disabled={choice.disabled || props.profile.disabled} onClick={() => props.profile.onChange(choice.value)}>{choice.label}</Button>)}
    <Button aria-keyshortcuts="Control+Enter Meta+Enter" disabled={!props.canSubmit || props.sending} onClick={props.onSubmit}>Shell.newTaskDialog.create</Button>
  </>,
} })
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })

let data: AgentProfilesView | undefined, readError: Error | undefined
const submitted: { text: string; context?: CoordinatorMessageContext }[] = []
const manualCommands: import('../../lib/task-create-command').CreateOnlyCommand[] = []
let failManual = false
mock.module(new URL('../../app/actions/issues.ts', import.meta.url).href, { namedExports: { createTaskOnly: async (command: import('../../lib/task-create-command').CreateOnlyCommand) => {
  manualCommands.push(command)
  if (failManual) throw new Error('response lost')
  return { version: 1, taskId: 'one-task', identifier: 'TEST-1', dispatch: null }
} } })
let refreshes = 0
const mutate = async () => { refreshes++ }
mock.module('swr', { defaultExport: (key: unknown) => {
  if (key === null) return { data: undefined, mutate }
  if (Array.isArray(key) && key[0] === 'factory-agent-profiles') return { data, error: readError, mutate }
  if (Array.isArray(key) && key[0] === 'settings:model-order') return { data: { location: 'cloud', first: { kind: 'cloud' }, entries: [], readyDeviceIds: [] }, mutate }
  return { data: key === 'issue-creation-available' ? true : [], mutate }
}, namedExports: { useSWRConfig: () => ({ mutate: async () => {} }) } })
mock.module(new URL('../../app/actions/agents.ts', import.meta.url).href, { namedExports: { listDevices: async () => [] } })
mock.module(new URL('../../app/actions/bots.ts', import.meta.url).href, { namedExports: { listBots: async () => [] } })
mock.module(new URL('../../app/actions/coordinator.ts', import.meta.url).href, { namedExports: { issueCreationAvailable: async () => true } })
mock.module(new URL('./use-coordinator-submit.ts', import.meta.url).href, { namedExports: {
  useCoordinatorSubmit: () => ({ submit: async (text: string, context?: CoordinatorMessageContext) => {
    submitted.push({ text, context }); return { kind: 'accepted' }
  }, failureMessage: () => null }),
} })
mock.module(new URL('../../hooks/use-computer.ts', import.meta.url).href, { namedExports: { useComputer: () => ({ data: undefined }) } })
mock.module(new URL('../../lib/settings-read.ts', import.meta.url).href, { namedExports: { settingsRead: async () => undefined } })
mock.module(new URL('../../lib/use-presence.ts', import.meta.url).href, { namedExports: { usePresence: () => ({ value: false, open: false, onOpenChangeComplete: () => {} }) } })
mock.module(new URL('../settings/e2b-key-dialog.tsx', import.meta.url).href, { namedExports: {
  useOwnE2BKey: () => ({ configured: true, mutate: async () => {} }), E2BKeyDialog: () => null,
} })
mock.module(new URL('../chat/use-chat-files.ts', import.meta.url).href, { namedExports: {
  useChatFiles: (text: string, edit: (text: string) => void) => ({ text, edit, add: () => {}, locked: false, files: [], pending: [] }),
} })
mock.module(new URL('../chat/chat-file-cards.tsx', import.meta.url).href, { namedExports: { ChatFileCards: () => null } })

const customId = '12250000-0000-4000-8000-000000000001'
const workspaceId = '12250000-0000-4000-8000-000000000002'
const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let TaskProfilePicker: typeof import('./task-profile-picker')['TaskProfilePicker']
let TaskProfileNotice: typeof import('./task-profile-picker')['TaskProfileNotice']
let NewTaskDialog: typeof import('./new-task-dialog')['NewTaskDialog']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && key === 'getComputedStyle' ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ Button } = await import('../ui/button'))
  ;({ Input } = await import('../ui/input'))
  ;({ TaskProfilePicker, TaskProfileNotice } = await import('./task-profile-picker'))
  ;({ NewTaskDialog } = await import('./new-task-dialog'))
})
beforeEach(() => {
  manualCommands.length = 0; failManual = false
  submitted.length = 0; refreshes = 0; readError = undefined
  data = { profiles: [{
    id: customId, name: 'Fixture role', description: '', roles: ['review'], icon: 'lens', color: 'pink', enabled: true, harness: 'claude_code',
    model: { mode: 'inherit' }, instructions: '', skills: [], version: 1, digest: 'a'.repeat(64),
    createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z', archivedAt: null,
  }], catalog: { models: [], skills: [] }, availability: { [customId]: { available: true } }, defaultAvailability: { available: true } }
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const render = async (node: ReactNode) => { await act(async () => root.render(node)) }
const option = (value: string) => container.querySelector<HTMLButtonElement>(`[data-option="${value}"]`)!
const create = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Shell.newTaskDialog.create')!
const dialog = () => <NewTaskDialog open onOpenChange={() => {}} workspaceId={workspaceId} initialText="Perform this one fixture task." />

test('Default awaiting an allowance check stays selectable and keeps its unresolved state visible', async () => {
  data!.defaultAvailability = { available: false, reason: 'checking' }
  data!.availability[customId] = { available: false, reason: 'checking' }
  let picked: string | null | undefined
  await render(<TaskProfilePicker workspaceId={workspaceId} value={null} onChange={value => { picked = value }} data={data} />)
  assert.equal(option('default').disabled, false)
  assert.match(option('default').textContent ?? '', /reasons.checking/)
  assert.doesNotMatch(option('default').textContent ?? '', /inherit/)
  assert.equal(option(customId).disabled, false, 'enabled custom Profiles may request the same authoritative allowance check')
  await act(async () => option('default').click())
  assert.equal(picked, 'default')
  assert.deepEqual(data!.defaultAvailability, { available: false, reason: 'checking' }, 'selection is not an availability grant')
  assert.equal(refreshes, 0)
})

test('a selected Default can submit its structured intent when allowance becomes checking, without a preview refresh', async () => {
  await render(dialog())
  await act(async () => option('default').click())
  data!.defaultAvailability = { available: false, reason: 'checking' }
  await render(dialog())
  assert.equal(create().disabled, false)
  assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /reasons.checking/)
  await act(async () => create().click())
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].context?.profileId, 'default')
  assert.equal(refreshes, 0, 'no manual/automatic management refresh is required to submit the intent')
})

test('confirmed Default refusal, missing preview, read failure and disabled custom roles prevent task submission', async () => {
  await render(dialog())
  await act(async () => option('default').click())
  for (const reason of ['balance', 'quota', 'disabled', 'paused', 'missing', 'noModels', 'noDevice', 'expired', 'keyRefused', 'providerUnavailable']) {
    data!.defaultAvailability = { available: false, reason }
    await render(dialog())
    assert.equal(option('default').disabled, true, reason)
    assert.equal(create().disabled, true, reason)
  }
  data!.defaultAvailability = undefined
  await render(dialog())
  assert.equal(option('default').disabled, true); assert.equal(create().disabled, true)
  data!.defaultAvailability = { available: false, reason: 'checking' }; readError = new Error('fixture read failure')
  await render(dialog())
  assert.equal(create().disabled, true, 'cached checking data cannot override a failed read')
  readError = undefined
  await act(async () => option(customId).click())
  data!.availability[customId] = { available: false, reason: 'checking' }; data!.profiles[0].enabled = false
  await render(dialog())
  assert.equal(option(customId).disabled, true); assert.equal(create().disabled, true)
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /reasons.disabled/)
  data!.profiles[0].enabled = true; data!.profiles[0].archivedAt = '2026-11-05T00:01:00Z'
  await render(dialog())
  assert.equal(option(customId).disabled, true); assert.equal(create().disabled, true)
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /reasons.archived/)
  assert.equal(submitted.length, 0); assert.equal(refreshes, 0)
})

test('checking is a non-blocking Default status; other unavailable choices retain their alert', async () => {
  data!.defaultAvailability = { available: false, reason: 'checking' }
  await render(<TaskProfileNotice value="default" data={data} onRetry={() => { refreshes++ }} />)
  assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /reasons.checking/)
  assert.equal(container.querySelector('[role="alert"]'), null)
  data!.availability[customId] = { available: false, reason: 'checking' }
  await render(<TaskProfileNotice value={customId} data={data} onRetry={() => { refreshes++ }} />)
  assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /reasons.checking/)
  assert.equal(container.querySelector('[role="alert"]'), null)
  data!.profiles[0].enabled = false
  await render(<TaskProfileNotice value={customId} data={data} onRetry={() => { refreshes++ }} />)
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /reasons.disabled/)
})

test('an enabled custom Profile submits only its structured reference while allowance is checking', async () => {
  await render(dialog())
  await act(async () => option(customId).click())
  data!.availability[customId] = { available: false, reason: 'checking' }
  await render(dialog())
  assert.equal(option(customId).disabled, false); assert.equal(create().disabled, false)
  assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /reasons.checking/)
  await act(async () => create().click())
  assert.equal(submitted.length, 1); assert.equal(submitted[0].context?.profileId, customId)
  assert.deepEqual(data!.availability[customId], { available: false, reason: 'checking' })
  assert.equal(refreshes, 0)
})

const titleInput = () => container.querySelector<HTMLInputElement>('#new-task-name')!
const typeTitle = async (value: string) => act(async () => {
  const input = titleInput()
  Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event)
})
test('a written title is sent as taskTitle beside the description', async () => {
  await render(dialog())
  assert.equal(titleInput().maxLength, 60)
  assert.equal(create().disabled, false, 'description alone still enables submit')
  await typeTitle('  Fix the login redirect  ')
  await act(async () => create().click())
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].context?.taskTitle, 'Fix the login redirect')
  assert.equal(submitted[0].text, 'Shell.newTaskDialog.prompt')
})

test('without a title nothing changes: no taskTitle key in the context', async () => {
  await render(dialog())
  await act(async () => create().click())
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].context?.taskTitle, undefined)
})

test('a title alone enables submit and becomes the request text', async () => {
  await render(<NewTaskDialog open onOpenChange={() => {}} workspaceId={workspaceId} />)
  assert.equal(create().disabled, true)
  await typeTitle('Only a title')
  assert.equal(create().disabled, false)
  await act(async () => create().click())
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].text, 'Shell.newTaskDialog.prompt', 'the request text is built from the title')
  assert.equal(submitted[0].context?.taskTitle, 'Only a title')
})

test('manual creation survives uncertain results, bypasses dispatch settings, and opens the returned Task', async () => {
  let opened = ''
  const form = <NewTaskDialog open workspaceId={workspaceId} initialIntent="create_only" initialText="Keep in backlog."
    onCreated={id => { opened = id }} onOpenChange={() => {}} />
  failManual = true
  await render(form)
  assert.equal(option('default'), null)
  const button = () => container.querySelector<HTMLButtonElement>('button[aria-keyshortcuts]')!
  await act(async () => { button().click(); button().click() })
  assert.equal(manualCommands.length, 1)
  assert.equal(opened, '')
  failManual = false
  await act(async () => { button().click() })
  assert.equal(manualCommands.length, 2)
  assert.deepEqual(manualCommands[0], manualCommands[1])
  assert.equal(manualCommands[0].title, 'Keep in backlog.')
  assert.equal(manualCommands[0].intent, 'create_only')
  assert.equal(submitted.length, 0)
  assert.equal(opened, 'one-task')
})

test('the same form explicitly switches to dispatch and sends only its selected command', async () => {
  await render(<NewTaskDialog open workspaceId={workspaceId} initialIntent="create_only" initialText="Run now."
    onCreated={() => {}} onOpenChange={() => {}} />)
  await act(async () => option('create_and_dispatch').click())
  assert.ok(option('default'))
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-keyshortcuts]')!.click())
  assert.equal(manualCommands.length, 0)
  assert.equal(submitted.length, 1)
  assert.deepEqual(submitted[0].context?.taskCommand, { version: 1, intent: 'create_and_dispatch', description: 'Run now.' })
  assert.equal(submitted[0].context?.expectedWorkspaceId, workspaceId)
})


test('Team creation retains its chosen identity when switching from backlog to dispatch', async () => {
  const teamId = '12250000-0000-4000-8000-000000000003'
  const team = <NewTaskDialog open workspaceId={workspaceId} teamId={teamId} initialIntent="create_only" initialText="Prepare release."
    onCreated={() => {}} onOpenChange={() => {}} />
  await render(team)
  await act(async () => create().click())
  assert.equal(manualCommands[0].teamId, teamId)
  await act(async () => root.render(null))
  await render(team)
  await act(async () => option('create_and_dispatch').click())
  await act(async () => create().click())
  assert.equal(submitted[0].context?.taskCommand?.teamId, teamId)
  assert.equal(submitted[0].context?.expectedWorkspaceId, workspaceId)
})
