import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createContext, useContext, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { AgentProfilesView } from '../settings/factory-profiles-data'
import type { CoordinatorMessageContext } from './use-coordinator-submit'
import type { SubmitOutcome } from '../../lib/eve/client'

// Source component contracts in Node, not a browser acceptance test. The
// existing Select primitive is reduced to its value/disabled/onChange contract.
const Selection = createContext<{ pick?: (value: string) => void; disabled?: boolean }>({})
const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>
let Button: typeof import('../ui/button')['Button']
let Input: typeof import('../ui/input')['Input']
let Textarea: typeof import('../ui/textarea')['Textarea']
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
    {props.project && <span data-crumb>{props.project}</span>}
    {props.projects && <>
      {props.projects.choices.map(choice => <Button key={choice.value} data-project={choice.value} disabled={props.projects!.disabled}
        onClick={() => props.projects!.onChange(choice.value)}>{choice.label}</Button>)}
      <Button data-project="" disabled={props.projects.disabled} onClick={() => props.projects!.onChange('')}>{props.projects.noneLabel}</Button>
    </>}
    {props.status && props.status.choices.map(choice => <Button key={choice.value} data-status={choice.value} data-status-picked={choice.value === props.status!.value}
      disabled={props.status!.disabled} onClick={() => props.status!.onChange(choice.value)}>{choice.label}</Button>)}
    {props.notices}
    {props.chooseIntent && (['create_only', 'create_and_dispatch'] as const).map(value => <Button key={value} data-option={value}
      disabled={props.chooseIntent!.disabled} onClick={() => props.chooseIntent!.onChange(value)}>{value}</Button>)}
    {props.intent !== 'create_only' && props.profile.choices.map(choice => <Button key={choice.value} data-option={choice.value}
      disabled={choice.disabled || props.profile.disabled} onClick={() => props.profile.onChange(choice.value)}>{choice.label}</Button>)}
    {props.agent.choices.map(choice => <Button key={choice.value} data-agent={choice.value} data-picked={choice.value === props.agent.value}
      disabled={props.agent.disabled} onClick={() => props.agent.onChange(choice.value)}>{choice.label}</Button>)}
    <Button data-more={props.more.checked} onClick={() => props.more.onChange(!props.more.checked)}>Shell.newTaskDialog.createMore</Button>
    <Textarea data-text value={props.text} onChange={event => props.onText(event.target.value)} />
    {props.startWork && <span data-start-work>{props.startWork.identifier} {props.startWork.title}</span>}
    {props.priority && props.priority.choices.map(choice => <Button key={choice.value} data-priority={choice.value} data-priority-picked={choice.value === props.priority!.value}
      onClick={() => props.priority!.onChange(choice.value)}>{choice.label}</Button>)}
    {props.assignee && props.assignee.choices.map(choice => <Button key={choice.value} data-assignee={choice.value} data-assignee-picked={choice.value === props.assignee!.value}
      onClick={() => props.assignee!.onChange(choice.value)}>{choice.label}</Button>)}
    {props.dueDate && props.dueDate.presets.map(preset => <Button key={preset.label} data-due={preset.label} onClick={() => props.dueDate!.onChange(preset.value)}>{preset.label}</Button>)}
    {props.labels && <Button data-label-create onClick={() => props.labels!.onCreate('Bug')}>create label</Button>}
    {props.access && <>
      <Button data-access="members" onClick={() => props.access!.onChange('members')}>members</Button>
      {props.access.members.map(member => <Button key={member.value} data-access-member={member.value} onClick={() => props.access!.onToggleMember(member.value)}>{member.label}</Button>)}
    </>}
    <Button aria-keyshortcuts="Control+Enter Meta+Enter" disabled={!props.canSubmit || props.sending} onClick={props.onSubmit}>Shell.newTaskDialog.create</Button>
  </>,
} })
mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: (namespace: string) => Object.assign((key: string) => `${namespace}.${key}`, { has: (key: string) => Boolean(key) }) } })

let data: AgentProfilesView | undefined, readError: Error | undefined
const submitted: { text: string; context?: CoordinatorMessageContext }[] = []
const manualCommands: import('../../lib/task-create-command').CreateOnlyCommand[] = []
let failManual = false, requireConsent = false
mock.module(new URL('../workspace/issue-metadata-controls.tsx', import.meta.url).href, { namedExports: {
  AccessChangeDialog: ({ onConfirm }: { onConfirm: () => Promise<boolean> }) => <Button data-confirm onClick={() => void onConfirm()}>Confirm</Button>,
} })
// The account menu's read: what the server shows as the current workspace, and how often the create action re-read it.
type Shown = { id: string; name: string; kind: string } | null
let shown: Shown = null, nextShown: Shown = null, switcherReads = 0, readFails = false, switcherError: Error | undefined
// After the fresh read answers: another tab switches before the create request is sent.
let afterRead: (() => void) | null = null
const switcher = (workspace: Shown) => workspace ? { workspace, accounts: [{ choices: [workspace] }] } : undefined
mock.module(new URL('../../lib/settings-data.ts', import.meta.url).href, { namedExports: {
  fetchSettingsData: async (url: string) => {
    assert.equal(url, '/api/workspace/switcher')
    switcherReads++
    if (readFails) throw new Error('fixture switcher read failure')
    shown = nextShown ?? shown
    const answer = switcher(shown)
    afterRead?.()
    return answer
  },
} })
// What the next submissions answer, in order; accepted once these run out.
let outcomes: SubmitOutcome[] = []
let refuseWorkspace = false
mock.module(new URL('../../app/actions/issues.ts', import.meta.url).href, { namedExports: { createTaskOnly: async (command: import('../../lib/task-create-command').CreateOnlyCommand) => {
  manualCommands.push(command)
  if (refuseWorkspace) return { error: 'workspaceAccessDenied' }
  if (failManual) throw new Error('response lost')
  if (requireConsent && !command.confirmAccess) return { error: 'accessChangeConfirmationRequired', params: { tasks: 1 }, confirmable: true }
  return { version: 1, taskId: 'one-task', identifier: 'TEST-1', dispatch: null }
} } })
let refreshes = 0
let dispatchedTask: string | undefined
const cacheRefreshes: unknown[] = []
const toasts: string[] = []
mock.module('sonner', { namedExports: { toast: { success: (text: string) => { toasts.push(text) }, error: (text: string) => { toasts.push(`error:${text}`) } } } })
const mutate = async () => { refreshes++ }
mock.module('swr', { defaultExport: (key: unknown) => {
  if (key === '/api/workspace/switcher') return { data: switcherError ? undefined : switcher(shown), error: switcherError, mutate: async () => switcher(shown) }
  if (key === null) return { data: undefined, mutate }
  if (Array.isArray(key) && key[0] === 'factory-agent-profiles') return { data, error: readError, mutate }
  if (Array.isArray(key) && key[0] === 'settings:model-order') return { data: { location: 'cloud', first: { kind: 'cloud' }, entries: [], readyDeviceIds: [] }, mutate }
  if (Array.isArray(key) && key[0] === 'new-task-options') return { data: options, mutate }
  if (key === 'bots') return { data: botList, mutate }
  return { data: key === 'issue-creation-available' ? true : [], mutate }
}, namedExports: { useSWRConfig: () => ({ mutate: async (key: unknown) => { cacheRefreshes.push(key) } }) } })
mock.module(new URL('../../app/actions/agents.ts', import.meta.url).href, { namedExports: { listDevices: async () => [] } })
let botList: { id: string; name: string; color: string; shape: string; coordinator?: boolean }[] = []
mock.module(new URL('../../app/actions/bots.ts', import.meta.url).href, { namedExports: { listBots: async () => botList } })
let options = { viewerId: 'viewer', members: [{ id: 'viewer', name: 'Viewer', image: null }], labels: [] as { name: string; color: string }[] }
mock.module(new URL('../../app/actions/issue-metadata.ts', import.meta.url).href, { namedExports: { getNewTaskOptions: async () => options } })
mock.module(new URL('../../app/actions/coordinator.ts', import.meta.url).href, { namedExports: { issueCreationAvailable: async () => true } })
mock.module(new URL('./use-coordinator-submit.ts', import.meta.url).href, { namedExports: {
  useCoordinatorSubmit: () => ({ submit: async (text: string, context?: CoordinatorMessageContext) => {
    submitted.push({ text, context }); return { kind: 'accepted', ...(dispatchedTask ? { task: { taskId: dispatchedTask } } : {}) }
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
mock.module(new URL('../slots/task-workspace.tsx', import.meta.url).href, { namedExports: {
  TaskWorkspace: ({ state }: { state: { status: string } }) => <span data-task-workspace={state.status} />,
} })

const customId = '12250000-0000-4000-8000-000000000001'
const workspaceId = '12250000-0000-4000-8000-000000000002'
const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let TaskProfilePicker: typeof import('./task-profile-picker')['TaskProfilePicker']
let TaskProfileNotice: typeof import('./task-profile-picker')['TaskProfileNotice']
let NewTaskDialog: typeof import('./new-task-dialog')['NewTaskDialog']
let StartWorkDialog: typeof import('./start-work-dialog')['StartWorkDialog']
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
  ;({ Textarea } = await import('../ui/textarea'))
  ;({ TaskProfilePicker, TaskProfileNotice } = await import('./task-profile-picker'))
  ;({ NewTaskDialog } = await import('./new-task-dialog'))
  ;({ StartWorkDialog } = await import('./start-work-dialog'))
})
beforeEach(() => {
  manualCommands.length = 0; failManual = false; requireConsent = false; botList = []; refuseWorkspace = false; outcomes = []
  shown = { id: workspaceId, name: 'Fixture workspace', kind: 'team' }; nextShown = null; switcherReads = 0; readFails = false; switcherError = undefined; afterRead = null
  options = { viewerId: 'viewer', members: [{ id: 'viewer', name: 'Viewer', image: null }], labels: [] }
  submitted.length = 0; refreshes = 0; readError = undefined; cacheRefreshes.length = 0; toasts.length = 0; dispatchedTask = undefined
  data = { profiles: [{
    id: customId, name: 'Fixture role', description: '', roles: [], icon: 'lens', color: 'pink', enabled: true, harness: 'auto',
    model: { mode: 'inherit' }, instructions: '', skills: [], version: 1, digest: 'a'.repeat(64),
    createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z', archivedAt: null,
  }], catalog: { models: [], skills: [] }, availability: { [customId]: { available: true } }, defaultAvailability: { available: true } }
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
// The person picks the Agent (nothing is preselected); most cases pick Codex right after the window opens.
const pickAgent = async (value: 'claude_code' | 'codex' = 'codex') => {
  const button = container.querySelector<HTMLButtonElement>(`[data-agent="${value}"]`)
  if (button) await act(async () => button.click())
}
const render = async (node: ReactNode, agent = true) => { await act(async () => root.render(node)); if (agent) await pickAgent() }
const option = (value: string) => container.querySelector<HTMLButtonElement>(`[data-option="${value}"]`)!
const create = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Shell.newTaskDialog.create')!
const task = { id: '12250000-0000-4000-8000-0000000000aa', identifier: 'TEST-7', title: 'Fixture task' }
const dialog = () => <StartWorkDialog open onOpenChange={() => {}} workspaceId={workspaceId} task={task} />

test('the menu offers no Agent 配置 and each Profile; none submits without a profileId', async () => {
  let picked: string | null | undefined = 'unset'
  await render(<TaskProfilePicker workspaceId={workspaceId} value={customId} onChange={value => { picked = value }} data={data} />)
  assert.equal(container.querySelector('[data-option="default"]'), null, 'the retired Default is not a choice')
  assert.equal(option('auto').disabled, false)
  await act(async () => option('auto').click())
  assert.equal(picked, null)
  await render(dialog())
  await act(async () => create().click())
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].context?.profileId, undefined, 'no Agent 配置 sends no reference')
})

test('disabled and archived Profiles prevent task submission; a read failure blocks a chosen Profile', async () => {
  await render(dialog())
  await act(async () => option(customId).click())
  data!.profiles[0].enabled = false
  await render(dialog())
  assert.equal(option(customId).disabled, true); assert.equal(create().disabled, true)
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /reasons.disabled/)
  data!.profiles[0].enabled = true; data!.profiles[0].archivedAt = '2026-11-05T00:01:00Z'
  await render(dialog())
  assert.equal(option(customId).disabled, true); assert.equal(create().disabled, true)
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /reasons.archived/)
  data!.profiles[0].archivedAt = null; readError = new Error('fixture read failure')
  await render(dialog())
  assert.equal(create().disabled, true, 'cached data cannot override a failed read')
  assert.equal(submitted.length, 0); assert.equal(refreshes, 0)
})

test('checking is a non-blocking status; a disabled Profile keeps its alert', async () => {
  data!.availability[customId] = { available: false, reason: 'checking' }
  await render(<TaskProfileNotice value={customId} data={data} onRetry={() => { refreshes++ }} />)
  assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /reasons.checking/)
  assert.equal(container.querySelector('[role="alert"]'), null)
  data!.profiles[0].enabled = false
  await render(<TaskProfileNotice value={customId} data={data} onRetry={() => { refreshes++ }} />)
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /reasons.disabled/)
  await render(<TaskProfileNotice value="default" data={data} onRetry={() => { refreshes++ }} />)
  assert.equal(container.querySelector('[role="alert"]'), null, 'a retired Default draft reads as none')
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

test('nothing is preselected: Start work waits for an Agent and creates no task', async () => {
  await render(dialog(), false)
  assert.equal(container.querySelector('[data-picked="true"]'), null, 'no Agent is preselected')
  assert.equal(create().disabled, true, 'no Agent, no dispatch')
  await act(async () => create().click())
  assert.equal(submitted.length, 0)
  await pickAgent('claude_code')
  assert.equal(create().disabled, false)
  await act(async () => create().click())
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].context?.taskCommand, undefined, 'Start work dispatches the existing task; it creates none')
})



test('a backlog entry waits for its authenticated workspace without changing to dispatch', async () => {
  await render(<NewTaskDialog open onOpenChange={() => {}} onCreated={() => {}} initialText="Keep in backlog." />)
  assert.equal(create().disabled, true)
  await act(async () => create().click())
  assert.equal(submitted.length, 0)
  assert.equal(manualCommands.length, 0)
})

test('manual creation survives uncertain results, bypasses dispatch settings, and opens the returned Task', async () => {
  let opened = ''
  const form = <NewTaskDialog open workspaceId={workspaceId} initialText="Keep in backlog."
    onCreated={id => { opened = id }} onOpenChange={() => {}} />
  failManual = true
  await render(form)
  await typeTitle('Keep in backlog.')
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



test('Team creation keeps its chosen identity', async () => {
  const teamId = '12250000-0000-4000-8000-000000000003'
  await render(<NewTaskDialog open workspaceId={workspaceId} teamId={teamId} initialText="Prepare release."
    onCreated={() => {}} onOpenChange={() => {}} />)
  await typeTitle('Prepare release.')
  await act(async () => create().click())
  assert.equal(manualCommands[0].teamId, teamId)
  assert.equal(submitted.length, 0)
})


test('new task uses the visible personal Project, accepts No project and preserves an explicit Project page', async t => {
  const saved = '12250000-0000-4000-8000-000000000004'
  const other = '12250000-0000-4000-8000-000000000005'
  let stored: string | null = saved
  let revision = 2
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (_path: unknown, options?: RequestInit) => {
    requests.push(options?.method ?? 'GET')
    if (options?.method === 'PUT') {
      const change = JSON.parse(String(options.body))
      assert.equal(change.readerId, 'reader')
      assert.equal(change.expectedRevision, revision++)
      stored = change.projectId
    }
    return Response.json({ organizationId: workspaceId, projectId: stored, revision,
      projects: [{ id: saved, name: 'First' }, { id: other, name: 'Second' }] })
  })
  const form = (explicit?: string) => <NewTaskDialog key={explicit ?? 'global'} readerId="reader" open workspaceId={workspaceId}
    projectId={explicit} project={explicit ? 'Second' : undefined} initialText="Prepare release."
    onCreated={() => {}} onOpenChange={() => {}} />
  await render(form())
  await typeTitle('Prepare release.')
  assert.equal(container.querySelector('[data-crumb]')?.textContent, 'First', 'the context line names the saved default Project')
  await act(async () => create().click())
  assert.equal(manualCommands[0].projectId, saved)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-project=""]')!.click())
  assert.equal(stored, null)
  assert.equal(container.querySelector('[data-crumb]'), null, 'no Project, no context line')
  await render(form(other))
  await typeTitle('Prepare release.')
  assert.equal(container.querySelector('[data-crumb]')?.textContent, 'Second', 'a project page keeps its own Project')
  await act(async () => create().click())
  assert.equal(manualCommands.at(-1)?.projectId, other)
  assert.deepEqual(requests, ['GET', 'PUT'])
})

test('a workspace with no Project draws no context line and still creates the task', async () => {
  let opened = ''
  await render(<NewTaskDialog open workspaceId={workspaceId} initialText="No Project here."
    onCreated={id => { opened = id }} onOpenChange={() => {}} />)
  await typeTitle('No Project here.')
  assert.equal(container.querySelector('[data-crumb]'), null)
  assert.equal(container.querySelector('[data-project]'), null, 'nothing to choose, so no picker')
  assert.equal(create().disabled, false, 'a missing Project is never a precondition')
  await act(async () => create().click())
  assert.equal(manualCommands.length, 1)
  assert.equal(manualCommands[0].projectId, undefined)
  assert.equal(opened, 'one-task')
})

test('the status chip starts on Todo and the picked status is the one the task is created in', async () => {
  await render(<NewTaskDialog open workspaceId={workspaceId} initialText="Keep in backlog."
    onCreated={() => {}} onOpenChange={() => {}} />)
  await typeTitle('Keep in backlog.')
  assert.equal(container.querySelector('[data-status-picked="true"]')?.getAttribute('data-status'), 'todo')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-status="doing"]')!.click())
  assert.equal(container.querySelector('[data-status-picked="true"]')?.getAttribute('data-status'), 'doing')
  await act(async () => create().click())
  assert.equal(manualCommands[0].status, 'doing', 'the chip reaches the create command')
})

test('Start work has no status chip and names the task it starts', async () => {
  await render(dialog())
  assert.equal(container.querySelector('[data-status]'), null)
  assert.equal(container.querySelector('[data-start-work]')?.textContent, 'TEST-7 Fixture task')
  assert.equal(submitted.length, 0)
  await act(async () => create().click())
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].text, 'Shell.newTaskDialog.startWorkPrompt', 'the request names the existing task')
  assert.equal(submitted[0].context?.taskCommand, undefined)
  assert.equal(submitted[0].context?.taskTitle, undefined)
  assert.equal(submitted[0].context?.expectedWorkspaceId, workspaceId)
  assert.deepEqual(toasts, ['Shell.newTaskDialog.startWorkSent'])
})

test('Project creation binds the UUID and retries only after a real access refusal is confirmed', async () => {
  const projectId = '12250000-0000-4000-8000-000000000004'
  requireConsent = true
  await render(<NewTaskDialog open workspaceId={workspaceId} project="Same name" projectId={projectId} initialText="Prepare release."
    onCreated={() => {}} onOpenChange={() => {}} />)
  await typeTitle('Prepare release.')
  await act(async () => create().click())
  assert.equal(manualCommands[0].projectId, projectId)
  assert.equal(manualCommands[0].confirmAccess, undefined)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-confirm]')!.click())
  assert.equal(manualCommands[1].requestId, manualCommands[0].requestId)
  assert.equal(manualCommands[1].confirmAccess, true)
  assert.equal(submitted.length, 0)
})

const moreSwitch = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Shell.newTaskDialog.createMore')!
const textField = () => container.querySelector<HTMLTextAreaElement>('textarea[data-text]')!

test('继续新建 on a backlog entry creates, clears the window and keeps it open without opening the Task', async () => {
  let opened = '', closed = false, added = 0
  await render(<NewTaskDialog open workspaceId={workspaceId} initialText="First backlog entry."
    onCreated={id => { opened = id }} onAdded={() => { added++ }} onOpenChange={next => { if (!next) closed = true }} />)
  await act(async () => moreSwitch().click())
  assert.equal(moreSwitch().dataset.more, 'true')
  await typeTitle('First title')
  await act(async () => create().click())
  assert.equal(manualCommands.length, 1)
  assert.equal(manualCommands[0].title, 'First title')
  assert.equal(opened, '', 'onCreated is not called while 继续新建 is on')
  assert.equal(closed, false, 'the window stays open')
  assert.equal(added, 1, 'the page re-reads its task lists')
  assert.deepEqual(toasts, ['Shell.newTaskDialog.createdTask'])
  assert.equal(titleInput().value, '')
  assert.equal(textField().value, '')
  assert.equal(create().disabled, true, 'nothing to send until the next request is written')
  await typeTitle('Second title')
  await act(async () => create().click())
  assert.equal(manualCommands.length, 2)
  assert.notEqual(manualCommands[1].requestId, manualCommands[0].requestId, 'the next task is a new request')
})


test('a title is required; the create window sends priority, assignee, due date, labels and access in its one command', async () => {
  botList = [{ id: 'bot-1', name: 'Captain', color: 'blue', shape: 'blob' }, { id: 'coord', name: 'Coordinator', color: 'blue', shape: 'blob', coordinator: true }]
  options = { viewerId: 'viewer', members: [{ id: 'viewer', name: 'Viewer', image: null }, { id: 'mate', name: 'Mate', image: null }], labels: [{ name: 'Infra', color: 'blue' }] }
  let opened = ''
  await render(<NewTaskDialog open workspaceId={workspaceId} initialText="Only a description." onCreated={id => { opened = id }} onOpenChange={() => {}} />)
  assert.equal(create().disabled, true, 'a description alone does not create a task')
  assert.equal(container.querySelector('[data-priority-picked="true"]')?.getAttribute('data-priority'), 'normal')
  assert.equal(container.querySelector('[data-assignee="bot:coord"]'), null, 'the Coordinator is not an assignee choice')
  await typeTitle('Fix login')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-priority="high"]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[data-assignee="bot:bot-1"]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[data-due="Shell.newTaskDialog.due.tomorrow"]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[data-label-create]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[data-access="members"]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[data-access-member="mate"]')!.click())
  assert.equal(container.querySelector('[data-access-member="viewer"]'), null, 'the creator always has access')
  await act(async () => create().click())
  assert.equal(manualCommands.length, 1)
  const command = manualCommands[0]
  assert.equal(command.title, 'Fix login')
  assert.equal(command.priority, 'high')
  assert.deepEqual(command.assignee, { kind: 'bot', id: 'bot-1' })
  assert.match(command.dueDate ?? '', /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(command.labels, [{ name: 'Bug', color: 'gray' }])
  assert.deepEqual(command.access, { kind: 'members', memberIds: ['mate'] })
  assert.equal(submitted.length, 0, 'creating dispatches nothing')
  assert.equal(opened, 'one-task')
})

test('opened from a Bot chat, the task is assigned to that Bot', async () => {
  botList = [{ id: 'bot-1', name: 'Captain', color: 'blue', shape: 'blob' }]
  await render(<NewTaskDialog open workspaceId={workspaceId} initialBotId="bot-1" onCreated={() => {}} onOpenChange={() => {}} />)
  assert.equal(container.querySelector('[data-assignee-picked="true"]')?.getAttribute('data-assignee'), 'bot:bot-1')
  await typeTitle('From the chat')
  await act(async () => create().click())
  assert.deepEqual(manualCommands[0].assignee, { kind: 'bot', id: 'bot-1' })
})

const slotState = () => container.querySelector('[data-task-workspace]')?.getAttribute('data-task-workspace')
const newTask = () => <NewTaskDialog open onOpenChange={() => {}} workspaceId={workspaceId} initialText="Perform this one fixture task." />

test('the create action confirms the captured workspace once and sends that id', async () => {
  await render(newTask())
  assert.equal(slotState(), 'ready')
  await typeTitle('Fix the login redirect')
  await act(async () => create().click())
  assert.equal(manualCommands.length, 1)
  assert.equal(manualCommands[0].workspaceId, workspaceId, 'the captured workspace rides the create command')
  assert.equal(switcherReads, 1, 'one fresh read right before submitting, no polling')
})

test('a switch in another tab between opening and submitting is a mismatch, and nothing is submitted', async () => {
  await render(newTask())
  nextShown = otherWorkspace
  await typeTitle('Fix the login redirect')
  await act(async () => create().click())
  assert.equal(manualCommands.length, 0, 'the task is never created in a workspace other than the captured one')
  assert.deepEqual(toasts, ['error:Shell.newTaskDialog.workspaceChanged'])
  await render(newTask())
  assert.equal(slotState(), 'mismatch')
  assert.equal(create().disabled, true)
})

test('a switch after the check does not change the workspace the create command carries', async () => {
  await render(newTask())
  afterRead = () => { shown = otherWorkspace }
  await typeTitle('Fix the login redirect')
  await act(async () => create().click())
  assert.equal(manualCommands.length, 1)
  assert.equal(manualCommands[0].workspaceId, workspaceId, 'still the captured workspace; the server checks it against its trusted selection')
})

test('the server refusing the captured workspace (switched after the check) creates nothing and keeps the text', async () => {
  await render(newTask())
  refuseWorkspace = true
  await typeTitle('Fix the login redirect')
  await act(async () => create().click())
  assert.equal(manualCommands.length, 1)
  assert.equal(manualCommands[0].workspaceId, workspaceId)
  assert.deepEqual(toasts, ['error:Shell.newTaskDialog.workspaceChanged'])
  assert.equal(textField().value, 'Perform this one fixture task.')
})

test('a retry after an uncertain send reuses the same request and captured workspace', async () => {
  await render(newTask())
  failManual = true
  await typeTitle('Fix the login redirect')
  await act(async () => create().click())
  assert.equal(manualCommands.length, 1)
  assert.equal(textField().value, 'Perform this one fixture task.')
  failManual = false
  await act(async () => create().click())
  assert.equal(manualCommands.length, 2)
  assert.equal(manualCommands[1].requestId, manualCommands[0].requestId, 'the frozen request reuses its id')
  nextShown = otherWorkspace
  await act(async () => create().click())
  assert.equal(manualCommands.length, 2, 'nothing is sent to the newly selected workspace')
  assert.deepEqual(manualCommands.map(item => item.workspaceId), [workspaceId, workspaceId])
})

test('loading, a failed read and no workspace refuse to create', async () => {
  shown = null
  await render(newTask())
  assert.equal(slotState(), 'loading')
  assert.equal(create().disabled, true)
  switcherError = new Error('fixture read failure')
  await render(newTask())
  assert.equal(slotState(), 'error')
  assert.equal(create().disabled, true)
  await act(async () => create().click())
  assert.equal(manualCommands.length, 0)
  assert.equal(switcherReads, 0, 'nothing is captured without a workspace')
})

test('a failed confirmation sends nothing and keeps the text for 重试', async () => {
  await render(newTask())
  readFails = true
  await typeTitle('Fix the login redirect')
  await act(async () => create().click())
  assert.equal(manualCommands.length, 0)
  assert.equal(textField().value, 'Perform this one fixture task.')
  assert.deepEqual(toasts, ['error:Shell.newTaskDialog.workspaceUnconfirmed'])
  readFails = false
  await act(async () => create().click())
  assert.equal(manualCommands.length, 1, 'retrying the same request after a successful read creates it')
  assert.equal(manualCommands[0].workspaceId, workspaceId)
})
