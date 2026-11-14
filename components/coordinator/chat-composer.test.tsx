import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createRef, useState } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { MESSAGE_MAX } from '@/lib/message-limits'
import { splitChatFiles, type ChatFileScope } from '@mikka/protocol/chat-attachments'

const errors: string[] = []
let removalNotice: { action: { onClick: (event: { preventDefault(): void }) => void }; cancel: { onClick: () => void } } | undefined
const uploaded = {
  id: '10000000-0000-4000-8000-000000000001',
  name: '长文件名_需求说明_最终版本_2026.md',
  mediaType: 'text/markdown',
  size: 120,
}
let upload: (file: File) => Promise<typeof uploaded> = async () => uploaded
let submissions: string[] = []
let editDraft: (value: string) => void
mock.module(new URL('../../lib/chat-attachments/client.ts', import.meta.url).href, {
  namedExports: {
    ChatUploadError: class extends Error {
      constructor(readonly code: string) {
        super(code)
      }
    },
    uploadChatFile: (file: File) => upload(file),
  },
})
mock.module('swr', { defaultExport: () => ({ data: uploaded }) })
mock.module('sonner', { namedExports: { toast: {
  error(message: string, options?: typeof removalNotice) { errors.push(message); removalNotice = options },
  dismiss() { removalNotice = undefined },
} } })
mock.module('next-intl', {
  namedExports: { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` },
})

const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: (typeof import('react-dom/client'))['createRoot']
let ChatComposer: (typeof import('./chat-composer'))['ChatComposer']
const inputRef = createRef<HTMLTextAreaElement>()

before(async () => {
  Object.assign(globalThis, {
    window: browser,
    self: browser,
    document: browser.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value:
        typeof value === 'function' && key === 'getComputedStyle'
          ? (value as (...args: unknown[]) => unknown).bind(browser)
          : value,
    })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ChatComposer } = await import('./chat-composer'))
})
beforeEach(() => {
  errors.length = 0
  removalNotice = undefined
  submissions = []
  upload = async () => uploaded
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
after(() => browser.happyDOM.close())

function Composer({
  initial = '',
  disabled = false,
  sending = false,
  thread = false,
  attachmentScope,
}: {
  initial?: string
  disabled?: boolean
  sending?: boolean
  thread?: boolean
  attachmentScope?: ChatFileScope
}) {
  const [draft, setDraft] = useState(initial)
  editDraft = setDraft
  return (
    <ChatComposer
      ref={inputRef}
      label="fixture-input"
      value={draft}
      onChange={setDraft}
      onSubmit={() => submissions.push(draft)}
      disabled={disabled}
      sending={sending}
      thread={thread}
      attachmentScope={attachmentScope}
    />
  )
}
const render = async (props: Parameters<typeof Composer>[0] = {}) => {
  await act(async () => root.render(<Composer {...props} />))
}
const block = (name: string, text: string) => `${name}\n\`\`\`\n${text}\n\`\`\``
function transfer(files: File[], types = ['Files']) {
  return {
    files,
    types,
    items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
    dropEffect: 'none',
  }
}
async function dispatch(
  type: string,
  data: ReturnType<typeof transfer>,
  target: Element = inputRef.current!,
) {
  const event = new browser.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: data })
  await act(async () => {
    target.dispatchEvent(event as unknown as Event)
  })
  return event
}

for (const thread of [false, true])
  test(`files dropped anywhere in the ${thread ? 'thread' : 'bot'} composer append to the draft`, async () => {
    await render({ initial: 'keep my words', thread })
    const data = transfer([
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      new File(['{}'], 'config.json'),
    ])
    const drag = await dispatch('dragover', data, container.querySelector('[data-slot="input-group-addon"]')!)
    assert.equal(drag.defaultPrevented, true)
    assert.equal(data.dropEffect, 'copy')
    const drop = await dispatch('drop', data, container.querySelector('[data-slot="input-group-addon"]')!)
    assert.equal(drop.defaultPrevented, true)
    assert.equal(
      inputRef.current!.value,
      `keep my words\n\n${block('notes.txt', 'hello')}\n\n${block('config.json', '{}')}`,
    )
    assert.equal(document.activeElement, inputRef.current)
  })

test('pasted files use the same attachment conversion as the picker', async () => {
  await render()
  const event = await dispatch('paste', transfer([new File(['# Title'], 'readme.md')]))
  assert.equal(event.defaultPrevented, true)
  assert.equal(inputRef.current!.value, block('readme.md', '# Title'))
})

test('ordinary pasted text and dragged text keep native editing behavior', async () => {
  await render({ initial: 'keep my words' })
  for (const type of ['paste', 'dragover', 'drop']) {
    assert.equal((await dispatch(type, transfer([], ['text/plain']))).defaultPrevented, false)
  }
  assert.equal(inputRef.current!.value, 'keep my words')
  assert.deepEqual(errors, [])
})

for (const state of [{ disabled: true }, { sending: true }])
  test(`file transfers cannot modify a ${state.disabled ? 'disabled' : 'sending'} composer`, async () => {
    await render({ initial: 'keep my words', ...state })
    const data = transfer([new File(['hello'], 'notes.txt')])
    assert.equal((await dispatch('dragover', data)).defaultPrevented, true)
    assert.equal(data.dropEffect, 'none')
    for (const type of ['drop', 'paste']) assert.equal((await dispatch(type, data)).defaultPrevented, true)
    assert.equal(inputRef.current!.value, 'keep my words')
    assert.deepEqual(errors, [])
  })

test('unsupported and oversized files report the existing error and preserve the draft', async () => {
  await render({ initial: 'keep my words' })
  for (const [type, file] of [
    ['drop', new File(['%PDF'], 'document.pdf', { type: 'application/pdf' })],
    ['paste', new File(['x'.repeat(MESSAGE_MAX)], 'large.txt')],
  ] as const)
    assert.equal((await dispatch(type, transfer([file]))).defaultPrevented, true)
  assert.equal(inputRef.current!.value, 'keep my words')
  assert.deepEqual(errors, ['Shell.attachUnsupported', 'Shell.attachUnsupported'])
})

test('the file picker still appends the file contents', async () => {
  await render()
  const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['hello'], 'notes.txt')] })
  await act(async () => {
    picker.dispatchEvent(new browser.Event('change', { bubbles: true }) as unknown as Event)
  })
  assert.equal(inputRef.current!.value, block('notes.txt', 'hello'))
})

for (const kind of ['bot', 'group', 'thread'] as const)
  test(`${kind} uploads preserve edits, show file cards, and send the immutable reference`, async () => {
    let finish!: (file: typeof uploaded) => void
    upload = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    await render({
      initial: 'old words',
      thread: kind === 'thread',
      attachmentScope: { kind, id: uploaded.id },
    })
    await dispatch('drop', transfer([new File(['# Original document'], uploaded.name)]))
    const send = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!
    assert.equal(send().disabled, true, 'incomplete files cannot be silently omitted from a send')
    await act(async () => editDraft('new words '))
    await act(async () => finish(uploaded))
    assert.equal(inputRef.current!.value, 'new words ')
    assert.equal(container.querySelector('[data-slot="attachment-title"]')?.textContent, uploaded.name)
    assert.equal(send().disabled, false)
    await act(async () => send().click())
    assert.deepEqual(splitChatFiles(submissions[0]), {
      text: 'new words ',
      files: [{ id: uploaded.id, name: uploaded.name }],
    })
  })

test('a failed upload preserves the draft, blocks send, and can be retried or removed', async (t) => {
  const deletion = t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ removed: true }))
  upload = async () => {
    throw Error('fixture-read-error')
  }
  await render({ initial: 'keep my words', attachmentScope: { kind: 'bot', id: uploaded.id } })
  await dispatch('paste', transfer([new File(['# Original'], uploaded.name)]))
  assert.equal(inputRef.current!.value, 'keep my words')
  assert.equal(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true)
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /errors.unavailable/)
  upload = async () => uploaded
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Shell.attachments.retry"]')!.click(),
  )
  assert.equal(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, false)
  // Removing a ready file restores the words without losing the draft.
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Shell.attachments.remove"]')!.click(),
  )
  assert.equal(inputRef.current!.value, 'keep my words')
  assert.equal(deletion.mock.callCount(), 1)
  assert.equal(container.querySelector('[data-slot="chat-file-cards"]'), null)
})

test('a rejected file removal keeps the attachment, protects send, and retries only the delete', async (t) => {
  let finish!: (response: Response) => void
  const deletion = t.mock.method(globalThis, 'fetch', (_url: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => { finish = resolve }))
  await render({ initial: 'keep my draft', attachmentScope: { kind: 'bot', id: uploaded.id } })
  await dispatch('paste', transfer([new File(['attachment'], uploaded.name)]))
  const remove = () => container.querySelector<HTMLButtonElement>('button[aria-label="Shell.attachments.remove"]')!
  const send = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!
  await act(async () => { remove().click(); remove().click() })
  assert.equal(deletion.mock.callCount(), 1)
  assert.equal(send().disabled, true)
  assert.ok(remove())
  await act(async () => { finish(Response.json({ error: 'unavailable' }, { status: 503 })) })
  assert.ok(remove())
  assert.equal(send().disabled, true)
  assert.equal(errors.at(-1), 'Shell.attachments.removeFailed')
  assert.ok(removalNotice)
  await act(async () => removalNotice!.action.onClick({ preventDefault() {} }))
  const last = deletion.mock.calls.at(-1)!
  assert.match(String(last.arguments[0]), new RegExp('/api/chat/attachments/' + uploaded.id + '$'))
  assert.equal(last.arguments[1]?.method, 'DELETE')
  await act(async () => { finish(Response.json({ removed: true })) })
  assert.equal(remove(), null)
  assert.equal(inputRef.current!.value, 'keep my draft')
  assert.equal(send().disabled, false)
})

test('keeping an attachment after a failed removal explicitly unlocks send', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline') })
  await render({ initial: 'keep', attachmentScope: { kind: 'bot', id: uploaded.id } })
  await dispatch('paste', transfer([new File(['attachment'], uploaded.name)]))
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Shell.attachments.remove"]')!.click())
  assert.ok(removalNotice)
  await act(async () => removalNotice!.cancel.onClick())
  const send = container.querySelector<HTMLButtonElement>('button[type="submit"]')!
  assert.equal(send.disabled, false)
  await act(async () => send.click())
  assert.deepEqual(splitChatFiles(submissions[0]), { text: 'keep', files: [{ id: uploaded.id, name: uploaded.name }] })
})
