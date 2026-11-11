import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// #1276: the v2 Factory block on the task page and its spec approval.
const zh = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))
const lookup = (key: string, args?: Record<string, string | number>) => {
  const value = key.split('.').reduce((node, part) => node?.[part], zh)
  assert.equal(typeof value, 'string', `missing ${key}`)
  return String(value).replace(/\{(\w+)\}/g, (_, name) => String(args?.[name] ?? ''))
}
const translators = new Map<string, typeof lookup>()
const translationsFor = (namespace = '') => {
  let translate = translators.get(namespace)
  if (!translate) { translate = (key, args) => lookup(namespace ? `${namespace}.${key}` : key, args); translators.set(namespace, translate) }
  return translate
}
const TASK = '11111111-1111-4111-8111-111111111111'
let flow: Record<string, unknown> | undefined
let flowError: unknown
let detail: unknown
let flowReloads = 0
let reloaded: string[] = []
let navigated: unknown[] = []
mock.module('swr', { defaultExport: (key: string | null) => {
  if (key === `/api/factory/tasks/${TASK}/flow`) return { data: flow, error: flowError, isValidating: false, mutate: async () => { flowReloads++; return flow } }
  if (key === `/api/factory/tasks/${TASK}`) return { data: detail, mutate: async () => detail }
  if (key?.startsWith('/api/factory/tasks?issueId=')) return { data: { tasks: [task] }, isLoading: false, mutate: async () => undefined }
  return { data: undefined, mutate: async () => undefined }
}, namedExports: { useSWRConfig: () => ({ mutate: async (key: string) => { reloaded.push(key) } }) } })
// The report's CI checks row reads the review summary (its own SWR and live keys); these tests cover the flow, not that row.
mock.module(new URL('../hooks/code-review/use-review-summary.ts', import.meta.url).href, { namedExports: { useReviewSummary: () => ({ data: undefined }) } })
mock.module('next-intl', { namedExports: { useTranslations: translationsFor, useFormatter: () => ({ dateTime: () => '', relativeTime: (at: Date, now: Date) => `${Math.round((now.getTime() - at.getTime()) / 3_600_000)} 小时前` }), useNow: () => new Date('2026-11-05T01:00:00.000Z') } })
mock.module(new URL('../components/workspace/issue-thread-panel.tsx', import.meta.url).href, { namedExports: { IssueThreadPanel: () => null } })
mock.module(new URL('../components/workspace/workspace-navigation.ts', import.meta.url).href, { namedExports: {
  navigate: (change: unknown) => { navigated.push(change) }, openArtifact: (id: string) => { navigated.push({ artifact: id }) },
  workspaceLink: (href: string) => href,
} })
// The report's diff rows use @pierre/diffs, which registers a web component on import; they draw only in a browser.
mock.module(new URL('../components/workspace/thread-changes.tsx', import.meta.url).href, { namedExports: {
  ThreadChangesPane: () => null, ThreadChangesView: () => null, ChangesTabLabel: () => null, Counts: () => null, FileSection: () => null,
  useDiffWrap: () => ['nowrap', () => {}],
} })

const browser = new Window({ url: 'https://mikka.example/zh-CN' })
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let FactoryAcceptance: typeof import('../components/workspace/factory-acceptance')['FactoryAcceptance']
let ownCapture: typeof import('../components/artifacts/artifact-document')['ownCapture']
let ArtifactDocument: typeof import('../components/artifacts/artifact-document')['ArtifactDocument']

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ FactoryAcceptance } = await import('../components/workspace/factory-acceptance'))
  ;({ ownCapture, ArtifactDocument } = await import('../components/artifacts/artifact-document'))
})
beforeEach(() => {
  flow = undefined; flowError = undefined; flowReloads = 0; reloaded = []; navigated = []
  detail = { task: { id: TASK, attemptId: 'spec-attempt', route: { flowVersion: 2 } }, attempts: [{ id: 'spec-attempt', runId: 'spec-run', stage: 'spec' }], liveWorkspaceId: null }
  container = document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container as unknown as Node)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); (container as unknown as { remove(): void }).remove() })
after(async () => { await browser.happyDOM.close() })

const task = { id: TASK, issueId: 'issue-1', stage: 'spec', status: 'passed', reason: '方案完成', candidateId: null, candidateRunId: null, isSkillCandidate: false, revision: 4 }
const specFlow = (patch: Record<string, unknown> = {}) => ({ version: 2, id: TASK, issueId: 'issue-1', botId: 'bot-1', revision: 4, stage: 'spec', stages: ['triage', 'spec'],
  needsYou: { kind: 'spec_review', since: '2026-11-05T00:00:00.000Z' }, review: null, acceptance: null, pullRequest: null, ...patch })
const opened: string[] = []
const render = async () => { await act(async () => root.render(<FactoryAcceptance issueId="issue-1" onOpenThread={id => opened.push(id)} />)) }
const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name) as unknown as HTMLButtonElement | undefined
const text = () => (container as unknown as HTMLElement).textContent ?? ''

async function withFetch(answers: (() => Response | Promise<Response>)[], run: (sent: { url: string; body: Record<string, any> }[]) => Promise<void>) {
  const sent: { url: string; body: Record<string, any> }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url, options) => {
    sent.push({ url: String(url), body: JSON.parse(String(options?.body)) })
    const next = answers.shift()
    if (!next) throw new Error('unexpected request')
    return next()
  }) as typeof fetch
  try { await run(sent) } finally { globalThis.fetch = original }
}
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status })

test('a finished spec shows its stages, 方案待审 and the approve action; no legacy acceptance heading', async () => {
  flow = specFlow()
  await render()
  assert.match(text(), /方案待审/)
  assert.deepEqual([...document.querySelectorAll('[data-slot="stepper-title"]')].map(item => item.textContent), ['分诊', '方案'])
  assert.equal(document.querySelector('[aria-current="step"] [data-slot="stepper-title"]')?.textContent, '方案')
  assert.ok(button('批准方案'))
  assert.equal(document.querySelector('h3[tabindex]'), null)
  await act(async () => { button('查看方案')!.click() })
  assert.deepEqual(opened.splice(0), ['spec-run'])
})

test('approve POSTs approve_spec with the revision once, even when clicked twice', async () => {
  flow = specFlow()
  await render()
  await withFetch([json(200, { binding: { taskId: TASK, revision: 6 }, stage: 'implement', replayed: false })], async sent => {
    await act(async () => { button('批准方案')!.click(); button('批准方案')!.click() })
    assert.equal(sent.length, 1)
    assert.ok(sent[0].url.endsWith(`/api/factory/tasks/${TASK}/flow`))
    assert.equal(sent[0].body.operation, 'approve_spec')
    assert.deepEqual(sent[0].body.input.binding, { taskId: TASK, revision: 4 })
    assert.match(sent[0].body.input.eventId, /^[0-9a-f-]{36}$/)
  })
  assert.ok(flowReloads >= 1)
  assert.ok(reloaded.includes(`/api/factory/tasks/${TASK}`))
  assert.ok(reloaded.includes('/api/factory/tasks?issueId=issue-1'))
  assert.equal(document.querySelector('[role="alert"]'), null)
})

test('an unanswered approval keeps its eventId for the retry; a stale one starts a new event', async () => {
  flow = specFlow()
  await render()
  await withFetch([
    () => { throw new TypeError('network') },
    json(200, { binding: { taskId: TASK, revision: 6 }, stage: 'implement', replayed: true }),
  ], async sent => {
    await act(async () => { button('批准方案')!.click() })
    assert.match(text(), /批准未确认/)
    await act(async () => { button('重新确认')!.click() })
    assert.equal(sent.length, 2)
    assert.equal(sent[1].body.input.eventId, sent[0].body.input.eventId)
  })
  await withFetch([json(409, { error: 'factoryStale' }), json(200, { binding: { taskId: TASK, revision: 6 }, stage: 'implement' })], async sent => {
    await act(async () => { button('批准方案')!.click() })
    assert.match(text(), /方案已更新/)
    // The server moved the task on; the reloaded spec has a new revision.
    flow = specFlow({ revision: 5 })
    await render()
    await act(async () => { button('批准方案')!.click() })
    assert.equal(sent.length, 2)
    assert.notEqual(sent[1].body.input.eventId, sent[0].body.input.eventId)
    assert.equal(sent[1].body.input.binding.revision, 5)
  })
})

test('a refused approval names why with its own copy', async () => {
  flow = specFlow()
  await render()
  await withFetch([json(409, { error: 'factoryEvidenceRequired' })], async () => {
    await act(async () => { button('批准方案')!.click() })
  })
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /方案线程未提交结果/)
  assert.ok(button('批准方案'))
})

test('a 409 quota refusal names the model problem, shows its code and ends the click', async () => {
  flow = specFlow()
  await render()
  await withFetch([json(409, { error: 'agentProfileModelUnavailable', detail: 'quota' }), json(200, { binding: { taskId: TASK, revision: 6 }, stage: 'implement' })], async sent => {
    await act(async () => { button('批准方案')!.click() })
    const alert = document.querySelector('[role="alert"]')?.textContent ?? ''
    assert.match(alert, /执行模型的额度已用完/)
    assert.doesNotMatch(alert, /批准未确认/)
    assert.match(alert, /详情/)
    assert.equal(button('重新确认'), undefined)
    // The refusal ended that click; the next one is a new event.
    await act(async () => { button('批准方案')!.click() })
    assert.equal(sent.length, 2)
    assert.notEqual(sent[1].body.input.eventId, sent[0].body.input.eventId)
  })
})

for (const [code, detail, expected] of [
  ['agentProfileDisabled', null, '执行配置已停用'],
  ['agentProfileArchived', null, '执行配置已归档'],
  ['agentProfileVersionConflict', null, '执行配置已更新，请重新查看后批准。'],
  ['agentProfileDecisionUnavailable', 'decision_unavailable', '未取得执行配置的选择结果'],
  ['agentProfileDecisionUnavailable', 'no_suitable_profile', '没有适合此任务的执行配置'],
  ['agentProfileDecisionUnavailable', 'invalid_profile_answer', '执行配置的选择结果格式无效'],
  ['agentProfileDecisionUnavailable', 'unknown_profile', '选中的执行配置不在可用列表中'],
  ['agentProfileDecisionUnavailable', 'uncertain_profile', '无法确定合适的执行配置'],
  ['agentProfileDecisionUnavailable', 'invalid_reason', '执行配置的选择理由无效'],
] as const) {
  test('an answered ' + code + (detail ? '/' + detail : '') + ' names its reason and ends the click', async () => {
    flow = specFlow()
    await render()
    await withFetch([json(409, { error: code, ...(detail ? { detail } : {}) }), json(200, { binding: { taskId: TASK, revision: 6 }, stage: 'implement' })], async sent => {
      await act(async () => { button('批准方案')!.click() })
      assert.equal(document.querySelector('[role="alert"] p')?.textContent?.trim(), expected)
      assert.equal(button('重新确认'), undefined)
      await act(async () => { button('批准方案')!.click() })
      assert.equal(sent.length, 2)
      assert.notEqual(sent[1].body.input.eventId, sent[0].body.input.eventId)
    })
  })
}

test('every Profile refusal has distinct copy in both languages', () => {
  const en = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'))
  for (const messages of [zh, en]) {
    const copy = messages.FactoryFlow.card.approveError
    for (const key of ['default', 'checking', 'quota', 'expired', 'paused', 'missing', 'removed', 'model_gone', 'key_refused', 'balance', 'provider_unavailable']) assert.equal(typeof copy.profileModel[key], 'string', key)
    for (const key of ['stale', 'transition', 'evidence', 'signedOut', 'notFound', 'profile', 'profileDisabled', 'profileArchived', 'profileVersionConflict', 'refused', 'unknown']) assert.equal(typeof copy[key], 'string', key)
    for (const key of ['decision_unavailable', 'no_suitable_profile', 'invalid_profile_answer', 'unknown_profile', 'uncertain_profile', 'invalid_reason']) assert.equal(typeof copy.profileDecision[key], 'string', key)
    assert.equal(new Set([copy.profile, copy.profileDisabled, copy.profileArchived, copy.profileVersionConflict, ...Object.values(copy.profileDecision)]).size, 10)
  }
})

test('handoff shows the report counts and opens the acceptance Artifact', async () => {
  flow = specFlow({ stage: 'handoff', stages: ['implement', 'review', 'handoff'], needsYou: { kind: 'pr_review', since: '2026-11-05T00:00:00.000Z' },
    acceptance: { artifactId: 'art-1', version: 2, runId: 'r', candidateId: 'c', counts: { passed: 4, unverified: 1, failed: 0 }, media: [] } })
  await render()
  assert.match(text(), /PR 待审/)
  // How long it has waited for the person (decision 2026-11-04-2200, rule 7).
  assert.match(text(), /1 小时前/)
  assert.match(text(), /4 项已验证/)
  assert.match(text(), /1 项未验证/)
  assert.doesNotMatch(text(), /项失败/)
  assert.equal(button('批准方案'), undefined)
  await act(async () => { button('打开验收页')!.click() })
  assert.deepEqual(navigated, [{ artifact: 'art-1' }])
})

test('a waiting question sends the person to the Bot chat (R-86)', async () => {
  flow = specFlow({ stage: 'implement', stages: ['implement'], needsYou: { kind: 'question', since: '2026-11-05T00:00:00.000Z' } })
  await render()
  await act(async () => { button('去回答')!.click() })
  assert.deepEqual(navigated, [{ section: 'coordinator', bot: 'bot-1', issue: null }])
})

test('an older task keeps its acceptance row, not a flow block', async () => {
  detail = { task: { id: TASK, attemptId: 'a', route: {} } }
  flow = specFlow()
  await render()
  assert.equal(button('批准方案'), undefined)
})

test('only this app\'s own capture links listed as media become players', () => {
  const media = [{ captureId: '22222222-2222-4222-8222-222222222222', kind: 'video' as const, title: '录屏' }]
  const origin = 'https://mikka.example'
  assert.equal(ownCapture(`${origin}/mikka/api/captures/22222222-2222-4222-8222-222222222222`, media, origin)?.kind, 'video')
  assert.equal(ownCapture('/api/captures/22222222-2222-4222-8222-222222222222', media, origin)?.kind, 'video')
  assert.equal(ownCapture('https://evil.example/api/captures/22222222-2222-4222-8222-222222222222', media, origin), null)
  assert.equal(ownCapture(`${origin}/api/captures/33333333-3333-4333-8333-333333333333`, media, origin), null)
  assert.equal(ownCapture(`${origin}/api/captures/22222222-2222-4222-8222-222222222222?x=1`, media, origin), null)
  assert.equal(ownCapture(`${origin}/api/captures/22222222-2222-4222-8222-222222222222`, [], origin), null)
})

test('bundled artifact captures use the trusted backend origin and local authenticated path', async () => {
  const captureId = '22222222-2222-4222-8222-222222222222'
  const media = [{ captureId, kind: 'video' as const, title: 'Recording' }]
  const markdown = `[Recording](https://mikka.example/mikka/api/captures/${captureId})`
  const props = { title: 'Acceptance', markdown, author: { authorName: '', authorColor: null, authorShape: null }, meta: '', quoted: [], quoting: null }
  browser.happyDOM.setURL('mikka://app/mikka')
  Object.defineProperty(browser, 'mikka', { configurable: true, value: { app: { runtime: 'electron', serverUrl: 'https://mikka.example/mikka' }, bundled: {} } })
  try {
    await act(async () => root.render(<ArtifactDocument {...props} media={media} />))
    assert.match(container.querySelector('video')?.getAttribute('src') ?? '', /^\/(?:mikka\/)?api\/captures\/22222222-2222-4222-8222-222222222222$/)
    await act(async () => root.render(<ArtifactDocument {...props} />))
    assert.equal(container.querySelector('video'), null, 'public details without authorized media remain plain links')
    await act(async () => root.render(<ArtifactDocument {...props} markdown={markdown.replace('mikka.example', 'foreign.example')} media={media} />))
    assert.equal(container.querySelector('video'), null, 'a listed ID does not authorize a foreign origin')
  } finally {
    Reflect.deleteProperty(browser, 'mikka')
    browser.happyDOM.setURL('https://mikka.example/zh-CN')
  }
})
