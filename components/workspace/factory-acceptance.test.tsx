import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

// The card must survive a 200 response that is not `{ tasks: [...] }`: an HTML
// fallback parses to `{}`, and an older API may send no `tasks` at all.
let data: unknown
let error: Error | undefined

mock.module('swr', { defaultExport: () => ({ data, error, mutate: async () => undefined }) })
mock.module('next-intl', { namedExports: {
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
} })
// The acceptance window pulls in server actions and the thread panel; only the
// card is under test here.
mock.module(new URL('./issue-thread-panel.tsx', import.meta.url).href, { namedExports: { IssueThreadPanel: () => null } })

let FactoryAcceptance: typeof import('./factory-acceptance')['FactoryAcceptance']
before(async () => { ({ FactoryAcceptance } = await import('./factory-acceptance')) })
beforeEach(() => { data = undefined; error = undefined })

const render = () => renderToStaticMarkup(<FactoryAcceptance issueId="11111111-1111-4111-8111-111111111111" identifier="MIK-1" />)

test('a response without a tasks array renders nothing instead of throwing', () => {
  data = {}
  assert.equal(render(), '')
  data = { tasks: null }
  assert.equal(render(), '')
  data = { tasks: 'nope' }
  assert.equal(render(), '')
})

test('an error response renders nothing', () => {
  error = new Error('factoryUnavailable')
  assert.equal(render(), '')
})

test('a real approval task still renders the acceptance card', () => {
  data = { tasks: [{ id: 'task-1', issueId: '11111111-1111-4111-8111-111111111111', stage: 'approval', status: 'pending', reason: 'Ready for review', candidateId: null, candidateRunId: null, isSkillCandidate: false }] }
  assert.match(render(), /Ready for review/)
})
