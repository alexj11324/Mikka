import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useState, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { EvidenceEntry } from '../lib/factory/evidence-view'

// A3 evidence viewer: thumbnails and chips, the stage, keyboard and filmstrip
// navigation, and the loading / error / retry states for media and text.
const zh = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8')).FactoryAcceptance
const lookup = (key: string, args?: Record<string, string>) => {
  const value = key.split('.').reduce((node, part) => node?.[part], zh)
  assert.equal(typeof value, 'string', `missing FactoryAcceptance.${key}`)
  return (value as string).replace(/\{(\w+)\}/g, (_, name) => args?.[name] ?? '')
}
mock.module('next-intl', { namedExports: { useTranslations: () => lookup, useFormatter: () => ({ dateTime: () => '10/28 14:20' }) } })
const Pass = ({ children, onKeyDown }: { children?: ReactNode; onKeyDown?: () => void }) => <div role="dialog" onKeyDown={onKeyDown}>{children}</div>
mock.module(new URL('../components/ui/dialog.tsx', import.meta.url).href, { namedExports: { Dialog: ({ children }: { children?: ReactNode }) => <>{children}</>, DialogContent: Pass, DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2> } })
mock.module(new URL('../components/workspace/short-sha.tsx', import.meta.url).href, { namedExports: { ShortSha: ({ sha }: { sha: string }) => <span>{sha.slice(0, 7)}</span> } })

const browser = new Window({ url: 'https://mikka.example/zh-CN' })
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let mod: typeof import('../components/workspace/factory-evidence')

const base = { runId: 'r1', recordedAt: '2026-10-28T06:20:00.000Z' }
const entries: EvidenceEntry[] = [
  { ...base, artifact: 'run-report:r1', kind: 'report', stage: 'execute' },
  { ...base, artifact: 'run-capture:c1', kind: 'screenshot', stage: 'verify', captureId: 'c1', title: '首页', contentType: 'image/png' },
  { ...base, artifact: 'run-capture:c2', kind: 'video', stage: 'verify', captureId: 'c2', title: '滚动', contentType: 'video/mp4', durationMs: 9000 },
]

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  ;({ createRoot } = await import('react-dom/client'))
  mod = await import('../components/workspace/factory-evidence')
})
beforeEach(() => {
  container = document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container as unknown as Node)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); (container as unknown as { remove(): void }).remove() })
after(() => browser.happyDOM.close())

const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`) as unknown as HTMLButtonElement | null
const counter = () => document.querySelector('[data-testid="evidence-counter"]')?.textContent
const key = async (name: string) => act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new browser.KeyboardEvent('keydown', { key: name, bubbles: true }) as unknown as Event) })

test('the window lists captures as thumbnails and text as chips, grouped by stage', async () => {
  const opened: number[] = []
  await act(async () => root.render(<mod.EvidenceList taskId="t1" entries={entries} onOpen={index => opened.push(index)} />))
  const headings = [...document.querySelectorAll('h5')].map(h => h.textContent)
  assert.deepEqual(headings, ['执行', '验证'])
  const shot = byLabel('截图 · 首页')!
  assert.equal(shot.querySelector('img')?.getAttribute('src'), '/api/factory/tasks/t1/evidence/c1')
  const clip = byLabel('录屏 · 滚动')!
  assert.match(clip.textContent ?? '', /0:09/)
  assert.equal(clip.querySelector('video'), null, 'a recording thumbnail never downloads the file')
  await act(async () => { byLabel('run-report:r1')!.click(); clip.click() })
  assert.deepEqual(opened, [0, 2])
})

test('no evidence is one line', async () => {
  await act(async () => root.render(<mod.EvidenceList taskId="t1" entries={[]} onOpen={() => {}} />))
  assert.equal(container.textContent, '没有证据')
})

function Viewer({ start = 0, readText }: { start?: number; readText: (name: string) => Promise<string> }) {
  const [index, setIndex] = useState(start)
  return <mod.EvidenceViewer taskId="t1" entries={entries} index={index} onIndex={setIndex} onClose={() => {}} readText={readText} sha={'a'.repeat(40)} environment="预览" />
}

test('text loads, then arrows, Home/End and the filmstrip move through every entry', async () => {
  const reads: string[] = []
  await act(async () => root.render(<Viewer readText={async name => { reads.push(name); return 'exit 0' }} />))
  assert.equal(counter(), '1 / 3')
  assert.match(container.querySelector('pre')?.textContent ?? '', /exit 0/)
  assert.equal(byLabel('上一条证据')!.disabled, true)
  await key('ArrowRight')
  assert.equal(counter(), '2 / 3')
  const image = [...container.querySelectorAll('img')].find(img => img.getAttribute('alt') === '首页')
  assert.equal(image?.getAttribute('src'), '/api/factory/tasks/t1/evidence/c1')
  assert.ok(container.querySelector('[data-testid="evidence-loading"]'), 'media shows a placeholder until it loads')
  await act(async () => { image!.dispatchEvent(new browser.Event('load') as unknown as Event) })
  assert.equal(container.querySelector('[data-testid="evidence-loading"]'), null)
  await key('End')
  assert.equal(counter(), '3 / 3')
  assert.equal(container.querySelector('video')?.getAttribute('src'), '/api/factory/tasks/t1/evidence/c2')
  assert.equal(byLabel('下一条证据')!.disabled, true)
  await key('ArrowRight')
  assert.equal(counter(), '3 / 3', 'the last entry stays put')
  await key('Home')
  assert.equal(counter(), '1 / 3')
  assert.deepEqual(reads, ['run-report:r1'], 'text read once, then cached')
  const strip = document.querySelector('[role="group"]')!
  await act(async () => { (strip.querySelector('[aria-label="录屏 · 滚动"]') as unknown as HTMLButtonElement).click() })
  assert.equal(counter(), '3 / 3')
  assert.equal(strip.querySelector('[aria-current="true"]')?.getAttribute('aria-label'), '录屏 · 滚动')
})

test('a failed read shows the error with retry, and retry reads again', async () => {
  let calls = 0
  await act(async () => root.render(<Viewer readText={async () => { calls++; if (calls === 1) throw new Error('down'); return 'ok' }} />))
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /证据打开失败/)
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === '重试')!.click() })
  assert.equal(calls, 2)
  assert.match(container.querySelector('pre')?.textContent ?? '', /ok/)
})

test('media that fails to load shows the error; retry asks for the file again', async () => {
  await act(async () => root.render(<Viewer start={1} readText={async () => ''} />))
  const image = [...container.querySelectorAll('img')].find(img => img.getAttribute('alt') === '首页')!
  await act(async () => { image.dispatchEvent(new browser.Event('error') as unknown as Event) })
  assert.ok(container.querySelector('[role="alert"]'))
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === '重试')!.click() })
  const again = [...container.querySelectorAll('img')].find(img => img.getAttribute('alt') === '首页')!
  assert.equal(again.getAttribute('src'), '/api/factory/tasks/t1/evidence/c1?attempt=1')
  assert.equal(container.querySelector('[role="alert"]'), null)
})
