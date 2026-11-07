import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useState, type ReactNode, type Ref } from 'react'
import type { Root } from 'react-dom/client'
import type { Cache } from 'swr'
import { Window } from 'happy-dom'
import type { ArtifactDetail } from '@/lib/artifacts/types'
import type { ListLiveRead } from '@/lib/live/list-read'
import { ReadResponseError } from '@/lib/swr/retry'
import { Textarea } from '@/components/ui/textarea'

type Detail = ArtifactDetail & { live: ListLiveRead }
const ARTIFACT = 'fixture-artifact'
const BODY = 'An already loaded passage stays selected while its background read recovers.'
const browser = new Window({ url: 'https://fixture.example/', settings: { disableIframePageLoading: true } })
const details = new Map<string, Detail | null>()
const texts = new Map<string, string | null>()
const failures = new Map<string, Error>()
const reads: string[] = []
const notices = new Map<string, { action?: { onClick: (event: Event) => void } }>()
const detailKey = (id = ARTIFACT) => `detail:${id}`
const textKey = (version = 2, id = ARTIFACT) => `text:${id}:${version}`
async function getArtifact(id: string) {
  const key = detailKey(id); reads.push(key)
  if (failures.has(key)) throw failures.get(key)
  return details.get(id) ?? null
}
async function getArtifactText(id: string, version: number) {
  const key = textKey(version, id); reads.push(key)
  if (failures.has(key)) throw failures.get(key)
  return texts.get(key) ?? null
}
const translate = (key: string) => key
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useFormatter: () => ({ dateTime: () => 'now' }) } })
mock.module('sonner', { namedExports: { toast: {
  error: (_message: string, options: { id: string; action?: { onClick: (event: Event) => void } }) => { notices.set(options.id, options) },
  dismiss: (id: string) => { notices.delete(id) },
} } })
mock.module('@/app/actions/artifacts', { namedExports: { getArtifact, getArtifactText } })
mock.module('@/hooks/use-live-key', { namedExports: { useLiveKey: () => {} } })
mock.module('./artifact-card', { namedExports: { ArtifactKindIcon: () => null, ArtifactAuthorAvatar: () => null } })
mock.module('./artifact-share', { namedExports: { ArtifactShare: () => null } })
mock.module('./selection-actions', { namedExports: { SelectionActions: ({ selection }: { selection: { text: string } | null }) => selection ? <div data-selection>{selection.text}</div> : null } })
const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>
mock.module('@/components/ui/dialog', { namedExports: {
  Dialog: Pass,
  DialogContent: ({ children, ref }: { children?: ReactNode; ref?: Ref<HTMLDivElement> }) => <div ref={ref} role="dialog">{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
} })
let pickVersion: (value: number) => void
mock.module('@/components/ui/dropdown-menu', { namedExports: {
  DropdownMenu: Pass, DropdownMenuContent: Pass, DropdownMenuRadioItem: Pass, DropdownMenuTrigger: Pass,
  DropdownMenuRadioGroup: ({ children, onValueChange }: { children?: ReactNode; onValueChange: (value: number) => void }) => { pickVersion = onValueChange; return <>{children}</> },
} })

let ArtifactViewer: typeof import('./artifact-viewer')['ArtifactViewer']
let SWRConfig: typeof import('swr')['SWRConfig']
let useSWR: typeof import('swr')['default']
let useSWRConfig: typeof import('swr')['useSWRConfig']
let createRoot: typeof import('react-dom/client')['createRoot']
let refreshDetail: () => Promise<unknown>, refreshText: (version?: number) => Promise<unknown>
let setChatDraft: (value: string) => void
let root: Root, container: HTMLDivElement
let cache: Cache
function ReadControl({ id }: { id: string }) {
  // ArtifactWindow reads this key before its nested Viewer, so it owns the deduplicated onSuccess.
  useSWR(['artifact', id], () => getArtifact(id))
  const { mutate } = useSWRConfig()
  refreshDetail = () => mutate(['artifact', id])
  refreshText = (version = 2) => mutate(['artifact-text', id, version])
  return null
}
function Chat() {
  const [draft, setDraft] = useState('next chat draft')
  setChatDraft = setDraft
  return <Textarea aria-label="Chat draft" value={draft} onChange={event => setDraft(event.target.value)} />
}
before(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const value = key === 'window' ? browser : (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig, useSWRConfig, default: useSWR } = await import('swr'))
  ;({ ArtifactViewer } = await import('./artifact-viewer'))
})
beforeEach(() => {
  details.clear(); texts.clear(); failures.clear(); reads.length = 0; notices.clear(); cache = new Map()
  details.set(ARTIFACT, { id: ARTIFACT, title: 'Retained document', kind: 'markdown', latestVersion: 2, runId: null, issueId: null,
    live: { ownerId: 'owner', workspaceId: null }, versions: [1, 2].map(version => ({ version, authorName: 'Writer', authorColor: null, authorShape: null, createdAt: '2026-11-07T00:00:00Z' })) })
  texts.set(textKey(), BODY); texts.set(textKey(1), 'Earlier version content')
  container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); browser.getSelection()?.removeAllRanges() })
after(() => browser.happyDOM.close())
async function render(id = ARTIFACT, scope = 'owner:workspace') {
  await act(async () => root.render(<SWRConfig key={scope} value={{ provider: () => cache, shouldRetryOnError: false, revalidateOnFocus: false, revalidateOnReconnect: false, dedupingInterval: 0 }}>
    <ReadControl id={id} /><ArtifactViewer artifactId={id} onArtifactChange={() => {}} onClose={() => {}} quotes={[]} bot={{ name: 'Bot', avatar: null }} chat={() => <Chat />} />
  </SWRConfig>))
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 50 && !check(); attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.ok(check(), 'the expected read result should become visible')
}
const documentBody = () => container.querySelector('[data-slot="artifact-document"]')
const chatInput = () => container.querySelector('textarea')!
const retry = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'retry')!
async function mount() { await render(); await until(() => !!documentBody() || !!container.querySelector('iframe') || !!retry()) }
async function revalidate(read = refreshDetail) { await act(async () => { await read().catch(() => {}) }) }

test('a failed background detail read retains the real document, selection, scroll and adjacent draft', async () => {
  await mount()
  const body = documentBody()!, paragraph = body.querySelector('p')!, scroll = body.closest('article')!.parentElement!
  const selected = document.createRange()
  selected.setStart(paragraph.firstChild!, 3); selected.setEnd(paragraph.firstChild!, 17)
  window.getSelection()!.addRange(selected)
  await act(async () => scroll.dispatchEvent(new browser.MouseEvent('mouseup', { bubbles: true }) as unknown as Event))
  assert.equal(container.querySelector('[data-selection]')?.textContent, 'already loaded')
  scroll.scrollTop = 380
  await act(async () => setChatDraft('keep this adjacent chat draft'))
  const input = chatInput(); input.focus(); input.setSelectionRange(5, 13)
  failures.set(detailKey(), new TypeError('fixture offline'))
  await revalidate()
  assert.ok(documentBody() === body, 'a background failure must not replace the loaded document')
  assert.ok(body.querySelector('p') === paragraph)
  assert.equal(container.querySelector('[data-selection]')?.textContent, 'already loaded')
  assert.equal(scroll.scrollTop, 380)
  assert.ok(chatInput() === input && document.activeElement === input)
  assert.equal(input.value, 'keep this adjacent chat draft')
  assert.deepEqual([input.selectionStart, input.selectionEnd], [5, 13])
  const notice = [...notices.values()][0]
  assert.ok(notice?.action)
  failures.delete(detailKey())
  await act(async () => notice.action!.onClick(new Event('click', { cancelable: true })))
  await until(() => !notices.size)
  assert.ok(documentBody() === body)
  assert.equal(scroll.scrollTop, 380)
})

test('an HTML artifact retains its iframe and element selection mode during a background detail failure', async () => {
  details.set(ARTIFACT, { ...details.get(ARTIFACT)!, kind: 'html' })
  await mount()
  const frame = container.querySelector('iframe')!
  const select = [...container.querySelectorAll('button')].find(button => button.textContent === 'selectElement')!
  await act(async () => select.click())
  failures.set(detailKey(), new TypeError('fixture offline'))
  await revalidate()
  assert.ok(container.querySelector('iframe') === frame, 'the iframe must not reload its document on a metadata read failure')
  assert.equal(select.getAttribute('aria-pressed'), 'true')
})

test('a background text retry refreshes the selected version without replacing its loaded document', async () => {
  await mount()
  await act(async () => pickVersion(1))
  await until(() => !!documentBody()?.textContent?.includes('Earlier version content'))
  const body = documentBody()!
  failures.set(textKey(1), new TypeError('fixture body offline'))
  await revalidate(() => refreshText(1))
  assert.ok(documentBody() === body)
  const notice = [...notices.values()][0]
  assert.ok(notice?.action)
  const before = reads.filter(key => key === textKey(1)).length
  failures.delete(textKey(1))
  await act(async () => notice.action!.onClick(new Event('click', { cancelable: true })))
  await until(() => !notices.size)
  assert.ok(reads.filter(key => key === textKey(1)).length > before, 'Retry must revalidate the current artifact-text key')
  assert.ok(documentBody() === body)
})

for (const part of ['detail', 'text'] as const) test(`an initial ${part} read failure keeps a local fallback and Retry actually recovers it`, async () => {
  const key = part === 'detail' ? detailKey() : textKey()
  failures.set(key, new TypeError('fixture offline initially'))
  await mount()
  assert.equal(!!documentBody(), false)
  assert.ok(retry())
  failures.delete(key)
  await act(async () => retry().click())
  await until(() => !!documentBody())
  assert.ok(documentBody()?.textContent?.includes(BODY))
})

for (const part of ['detail', 'text'] as const) for (const status of [401, 403, 404]) test(`a ${part} ${status} refusal keeps old content hidden through network failure and restores only after a successful read`, async () => {
  await mount()
  const key = part === 'detail' ? detailKey() : textKey()
  const refresh = part === 'detail' ? refreshDetail : () => refreshText()
  failures.set(key, new ReadResponseError(status))
  await revalidate(refresh)
  assert.equal(!!documentBody(), false)
  assert.equal(container.textContent?.includes('Retained document'), false, 'refused metadata must not remain in the reader header')
  failures.set(key, new TypeError('fixture offline after refusal'))
  await revalidate(refresh)
  assert.equal(!!documentBody(), false, 'a transport failure cannot resurrect rejected cached content')
  assert.equal(container.textContent?.includes('Retained document'), false)
  assert.equal(notices.size, 0)
  failures.delete(key)
  await revalidate(refresh)
  assert.ok(documentBody(), 'a successful re-read of identical data must restore the document, including a deduplicated outer detail read')
})

for (const part of ['detail', 'text'] as const) test(`a missing ${part} response removes the previously loaded document`, async () => {
  await mount()
  if (part === 'detail') details.set(ARTIFACT, null)
  else texts.set(textKey(), null)
  await revalidate(part === 'detail' ? refreshDetail : () => refreshText())
  assert.equal(!!documentBody(), false)
  assert.ok(retry())
})

test('another artifact or authenticated cache scope cannot borrow the old document after a failed read', async () => {
  await mount()
  failures.set(detailKey('other-artifact'), new TypeError('fixture other artifact offline'))
  await render('other-artifact')
  await until(() => !!retry())
  assert.equal(!!documentBody(), false)
  failures.set(detailKey(), new TypeError('fixture new scope offline'))
  cache = new Map()
  await render(ARTIFACT, 'other-owner:other-workspace')
  await until(() => !!retry())
  assert.equal(!!documentBody(), false)
  assert.equal(container.textContent?.includes(BODY), false)
})
