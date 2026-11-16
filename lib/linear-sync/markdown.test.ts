import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { issueContentToMarkdown, linearMarkdownToPlainText, plainTextToLinearMarkdown } from './markdown'
import { linearDescriptionChanged } from './sync-guards'

test('plain app comments survive Linear Markdown formatting and line breaks', () => {
  for (const body of [
    'See [spec](https://example.com) exactly',
    'first\nsecond',
    'first\n\nthird',
    '- a literal list marker',
    '1. a literal ordered marker',
    '# a literal heading',
    'a\\path and *literal* text',
  ]) {
    assert.equal(linearMarkdownToPlainText(plainTextToLinearMarkdown(body)), body)
  }
})

test('unchanged Linear Markdown does not replace local rich text', () => {
  const remote = 'A **formatted** description'
  const hash = createHash('sha256').update(remote).digest('hex')
  assert.equal(linearDescriptionChanged(remote, hash, remote), false)
  assert.equal(linearDescriptionChanged('A changed description', hash, remote), true)
  assert.equal(linearDescriptionChanged(remote, null, remote), false)
  assert.equal(linearDescriptionChanged('A changed description', null, remote), true)
})

test('mobile Task descriptions keep native mention display labels without exporting identities or changing the Linear snapshot', () => {
  const nodes = [
    { type: 'text', text: 'Ask ' },
    { type: 'mention', attrs: { id: 'test-account-id', label: 'A*[Ren]' } },
    { type: 'text', text: ' today' },
    { type: 'mention', attrs: { id: 'legacy-account-id' } },
  ]
  const paragraph = { type: 'paragraph', content: nodes }
  const doc = { type: 'doc', content: [paragraph, { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph] }] }] }
  const mobile = issueContentToMarkdown(doc, { mentionLabels: true })
  const visible = 'Ask @A*[Ren] today'
  assert.equal(linearMarkdownToPlainText(mobile).trim(), visible + '\n\n' + visible)
  assert.doesNotMatch(mobile, /test-account-id|legacy-account-id/)
  assert.equal(issueContentToMarkdown(doc), 'Ask  today\n\n- Ask  today')
})
