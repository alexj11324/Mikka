import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptanceSection, inspectAcceptance } from './pr-acceptance-check.mjs'

const evidence = `## Acceptance
Runtime: device
Model: scripted (fake LiteLLM)
Commit: 679022e02d24c445bcf23235e1e68ff757830d84
Fixtures: tool-then-text.jsonl
Items: 1, 2, 5 — 3/3 passed
`
const screenshot = '![Thread tool result](https://github.com/user-attachments/assets/example-capture)'

test('accepts a version-bound scripted local-loop declaration and item summary', () => {
  assert.equal(inspectAcceptance({ body: evidence, files: ['lib/run.ts'] }).status, 'pass')
})

test('requires a visible non-placeholder section', async t => {
  for (const [name, body, error] of [
    ['missing', '## What and why\nFix a task.', 'acceptance.missing'],
    ['empty template comment', '## Acceptance\n<!-- Add evidence here -->', 'acceptance.placeholder'],
    ['placeholder', '## Acceptance\nTBD', 'acceptance.placeholder'],
    ['commented section', '<!-- ## Acceptance\nNot needed: documentation -->', 'acceptance.missing'],
    ['example in a fence', '```md\n## Acceptance\nNot needed: documentation\n```', 'acceptance.missing'],
    ['fenced declaration', '## Acceptance\n```md\nNot needed: documentation\n```', 'acceptance.placeholder'],
    ['unclosed fenced declaration', '## Acceptance\n```md\nNot needed: documentation', 'acceptance.placeholder'],
    ['indented declaration', '## Acceptance\n    Not needed: documentation', 'acceptance.placeholder'],
    ['duplicate', `${evidence}\n## Acceptance\nNot needed: docs`, 'acceptance.duplicate'],
  ]) await t.test(name, () => assert(inspectAcceptance({ body }).errors.includes(error)))
})

test('UI screenshots belong to Acceptance, with a reasoned exemption available', () => {
  const files = ['components/tasks/task-row.tsx']
  assert(inspectAcceptance({ body: evidence, files }).errors.includes('acceptance.screenshot-missing'))
  assert.equal(inspectAcceptance({ body: `${evidence}\n${screenshot}`, files }).status, 'pass')
  assert(inspectAcceptance({ body: `${evidence}\n## Other\n${screenshot}`, files }).errors.includes('acceptance.screenshot-missing'))
  assert(inspectAcceptance({ body: `${evidence}\n\`\`\`md\n${screenshot}\n\`\`\``, files }).errors.includes('acceptance.screenshot-missing'))
  assert.equal(inspectAcceptance({ body: '## Acceptance\nNot needed: pure prop type refactor covered by task-row tests.', files }).status, 'pass')
})

test('detects renamed UI files and does not require screenshots for API handlers or tests', () => {
  assert(inspectAcceptance({ body: evidence, files: [{ filename: 'lib/task-row.tsx', previous_filename: 'components/task-row.tsx' }] }).errors.includes('acceptance.screenshot-missing'))
  assert.equal(inspectAcceptance({ body: evidence, files: ['app/api/tasks/route.ts', 'app/actions/tasks.ts', 'components/task-row.test.tsx'] }).status, 'pass')
})

test('Not needed requires a concrete reason', async t => {
  for (const reason of ['', 'TBD', '<reason>', '...']) await t.test(reason || 'empty', () => {
    assert(inspectAcceptance({ body: `## Acceptance\nNot needed: ${reason}` }).errors.includes('acceptance.reason-missing'))
  })
  assert(inspectAcceptance({ body: '## Acceptance\nNot needed:\nOwner: someone' }).errors.includes('acceptance.reason-missing'))
})

test('Production only requires an external limitation, owner and internal account alias', () => {
  const body = '## Acceptance\nProduction only: OAuth callback needs the real provider installation.\nOwner: @alexj11324\nInternal account: shared SMOKE alias'
  assert.equal(inspectAcceptance({ body }).status, 'pass')
  for (const [line, error] of [
    ['Owner: @alexj11324', 'acceptance.owner-missing'],
    ['Internal account: shared SMOKE alias', 'acceptance.internal-account-missing'],
  ]) assert(inspectAcceptance({ body: body.replace(line, '') }).errors.includes(error))
  assert(inspectAcceptance({ body: body.replace('OAuth callback needs the real provider installation.', 'I did not run the tests.') }).errors.includes('acceptance.production-scope'))
  assert(inspectAcceptance({ body, files: ['app/settings/page.tsx'] }).errors.includes('acceptance.screenshot-missing'))
})

test('draft declarations are not acceptance passes and are evaluated when ready', () => {
  assert.equal(inspectAcceptance({ body: '', draft: true }).status, 'draft')
  assert.equal(inspectAcceptance({ body: '', draft: false }).status, 'fail')
})

test('evidence must identify runtime, scripted model, fixture and tested revision', () => {
  for (const [line, error] of [
    ['Runtime: device', 'acceptance.runtime-missing'],
    ['Model: scripted (fake LiteLLM)', 'acceptance.scripted-model-missing'],
    ['Commit: 679022e02d24c445bcf23235e1e68ff757830d84', 'acceptance.commit-missing'],
    ['Fixtures: tool-then-text.jsonl', 'acceptance.fixture-missing'],
    ['Items: 1, 2, 5 — 3/3 passed', 'acceptance.evidence-missing'],
  ]) assert(inspectAcceptance({ body: evidence.replace(line, '') }).errors.includes(error))
  for (const count of ['0/0 passed', '2/3 passed']) {
    assert(inspectAcceptance({ body: evidence.replace('3/3 passed', count) }).errors.includes('acceptance.evidence-missing'))
  }
})

test('section parsing retains report fences and nested headings', () => {
  assert.deepEqual(acceptanceSection('## Acceptance\n### Device\n```text\n3/3 passed\n```\n## Review\nignored'), ['### Device\n```text\n3/3 passed\n```'])
})
