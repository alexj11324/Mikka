import { test } from 'node:test'
import assert from 'node:assert/strict'
import { citedIds, splitCitations } from './citations'

const ISSUE = '3f6c1a52-8d0e-4b7a-9c3e-1f2a3b4c5d6e'
const RUN = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

test('splitCitations keeps text and citations in order', () => {
  assert.deepEqual(splitCitations(`Dispatched [[run:${RUN}]] for [[issue:${ISSUE}]].`), [
    { type: 'text', text: 'Dispatched ' },
    { type: 'citation', kind: 'run', id: RUN, raw: `[[run:${RUN}]]` },
    { type: 'text', text: ' for ' },
    { type: 'citation', kind: 'issue', id: ISSUE, raw: `[[issue:${ISSUE}]]` },
    { type: 'text', text: '.' },
  ])
})

test('splitCitations reads a bare id as a citation of either kind', () => {
  assert.deepEqual(splitCitations(`Run ${RUN.toUpperCase()} is queued`), [
    { type: 'text', text: 'Run ' },
    { type: 'citation', kind: null, id: RUN, raw: RUN.toUpperCase() },
    { type: 'text', text: ' is queued' },
  ])
  assert.deepEqual(splitCitations('nothing cited'), [{ type: 'text', text: 'nothing cited' }])
})

test('citedIds looks bare ids up as both issues and runs', () => {
  assert.deepEqual(citedIds([`[[issue:${ISSUE}]] and ${RUN}`, `[[run:${RUN}]]`]), { issueIds: [ISSUE, RUN], runIds: [RUN] })
})
