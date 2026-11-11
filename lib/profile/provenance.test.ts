import assert from 'node:assert/strict'
import { test } from 'node:test'
import { factInput, parseFacts } from './facts'
import { memoryTargetUrl, notificationMemorySource, notificationSourceUrl, suggestionSourceId } from './provenance'
import { readLocation } from '@/components/workspace/workspace-navigation'
import { BASE_PATH } from '@/lib/base-path'

const id = '10000000-0000-4000-8000-000000000001'
const github = { id, source: 'github' as const, externalId: 'comment:1234', matterKey: 'github:owner/repo#17', url: 'https://github.com/owner/repo/issues/17#issuecomment-1234' }

test('production factInput records only the real notice reference, never model-provided provenance', () => {
  const [fact] = parseFacts(JSON.stringify({ facts: [{ kind: 'preference', subject: 'Plain text', confidence: 0.5,
    source: { kind: 'file', id: 'foreign', url: 'https://outside.invalid/private' } }] }))
  const input = factInput(fact, { source: 'github', externalId: github.externalId, occurredAt: new Date('2026-11-09T10:00:00Z') }, id)
  assert.deepEqual(input.source, { kind: 'thread', id: `suggestion:${id}`, url: null })
  assert.deepEqual(notificationMemorySource({ sourceKind: input.source!.kind, sourceId: input.source!.id, evidence: input.evidence }, github),
    { kind: 'thread', id: `suggestion:${id}`, url: github.url })
  assert.equal(notificationMemorySource({ sourceKind: 'thread', sourceId: `suggestion:${id}`, evidence: [{ ...input.evidence[0], externalId: 'comment:5678' }] }, github), null)
  assert.equal(suggestionSourceId(id), null, 'an external notice is never confused with an internal Bot id')
})

test('GitHub links bind the exact repository, issue and originating event', () => {
  assert.equal(notificationSourceUrl(github), github.url)
  for (const url of ['https://github.com/owner/other/issues/17#issuecomment-1234', 'https://github.com/owner/repo/issues/18#issuecomment-1234',
    'https://github.com/owner/repo/issues/17#issuecomment-5678', 'https://github.com.evil.invalid/owner/repo/issues/17#issuecomment-1234',
    'https://owner:password@github.com/owner/repo/issues/17#issuecomment-1234', 'https://github.com/owner/repo/issues/17?next=foreign#issuecomment-1234',
    '/mikka/?bot=foreign', 'javascript:alert(1)']) assert.equal(notificationSourceUrl({ ...github, url }), null)
  const pull = 'https://github.com/owner/repo/pull/17'
  assert.equal(notificationSourceUrl({ ...github, externalId: 'review:42', url: `${pull}#pullrequestreview-42` }), `${pull}#pullrequestreview-42`)
  assert.equal(notificationSourceUrl({ ...github, externalId: 'review_comment:42', url: `${pull}#discussion_r42` }), `${pull}#discussion_r42`)
  assert.equal(notificationSourceUrl({ ...github, externalId: 'owner/repo#17:review_requested:at', url: pull }), pull)
})

test('Gmail and Notion use the stored thread/page identity, not merely an allowed hostname', () => {
  const gmail = { ...github, source: 'gmail' as const, externalId: 'message1', matterKey: 'gmail:thread1', url: 'https://mail.google.com/mail/u/0/#all/thread1' }
  assert.equal(notificationSourceUrl(gmail), gmail.url)
  assert.equal(notificationSourceUrl({ ...gmail, url: 'https://mail.google.com/mail/u/0/#all/thread2' }), null)
  const page = '01234567-89ab-cdef-0123-456789abcdef', compact = page.replaceAll('-', '')
  const notion = { ...github, source: 'notion' as const, externalId: `${page}:2026-11-09`, matterKey: `notion:${page}`, url: `https://www.notion.so/Plan-${compact}` }
  assert.equal(notificationSourceUrl(notion), notion.url)
  assert.equal(notificationSourceUrl({ ...notion, url: `https://work.notion.site/Plan-${compact}?pvs=4` }), `https://work.notion.site/Plan-${compact}?pvs=4`)
  assert.equal(notificationSourceUrl({ ...notion, url: 'https://www.notion.so/Plan-11111111111111111111111111111111' }), null)
  assert.equal(notificationSourceUrl({ ...notion, url: `https://www.notion.so/Plan-${compact}?next=private` }), null)
})

test('sources without a verifiable provider locator retain only their notice ID', () => {
  for (const source of ['slack', 'linear'] as const) assert.equal(notificationSourceUrl({ ...github, source }), null)
  for (const kind of ['thread', 'task'] as const) {
    const url = new URL(memoryTargetUrl(kind, id), 'https://mikka.invalid')
    assert.equal(url.pathname, BASE_PATH || '/')
    const location = readLocation(url.searchParams)
    assert.equal(location.section, 'coordinator')
    assert.equal(kind === 'thread' ? location.bot : location.issue, id, 'the canonical navigation parser opens this actual target')
    assert.equal(kind === 'thread' ? location.issue : location.bot, null)
  }
})
