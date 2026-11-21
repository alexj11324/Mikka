import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'
import { ISSUE_STATUS_MARKS, MARK_SHAPE_NAMES, markToneClass, stateMarkTone } from '@/lib/state-mark'
import { PRIORITY_ICONS, STATUS_ICONS, Mark, StateMark } from './state-mark'

test('every shape the vocabulary names draws, in the one box', () => {
  for (const shape of MARK_SHAPE_NAMES) {
    const markup = renderToStaticMarkup(<Mark shape={shape} />)
    assert.match(markup, /viewBox="0 0 14 14"/, `${shape} draws in the 14 box`)
    assert.match(markup, /stroke="currentColor"/, `${shape} takes the colour of where it sits`)
    assert.match(markup, /stroke-width="1.25"/, `${shape} is stroked at 1.25`)
    assert.match(markup, new RegExp(`data-mark="${shape}"`))
    assert.match(markup, /<(?:circle|path|rect)/, `${shape} has a drawing`)
  }
})

test('a mark takes its colour and its size from the registry, never from a call site', () => {
  assert.match(renderToStaticMarkup(<Mark shape="half" tone="yellow" />), new RegExp(markToneClass.yellow))
  assert.doesNotMatch(renderToStaticMarkup(<Mark shape="half" />), /text-(?:muted|warning|success|info|label|destructive)/, 'no tone, no colour of its own')
  assert.match(renderToStaticMarkup(<Mark shape="half" tone="yellow" size="lg" />), /size-\[18px\]/)
  assert.match(renderToStaticMarkup(<Mark shape="half" tone="yellow" size="md" />), /size-4/)
  assert.match(renderToStaticMarkup(<Mark shape="half" tone="yellow" />), /size-3\.5/)
  assert.match(renderToStaticMarkup(<Mark shape="progress" tone="yellow" spin />), /animate-spin/)
})

test('one icon per status and per priority, drawn from the same table', () => {
  for (const status of ISSUE_STATUS_CODES) {
    const Icon = STATUS_ICONS[status]
    assert.match(renderToStaticMarkup(<Icon />), new RegExp(`data-mark="${ISSUE_STATUS_MARKS[status].shape}"`), `${status}'s icon is its mark`)
    assert.match(renderToStaticMarkup(<Icon />), new RegExp(markToneClass[ISSUE_STATUS_MARKS[status].tone]))
  }
  for (const priority of ISSUE_PRIORITY_CODES) {
    const Icon = PRIORITY_ICONS[priority]
    assert.match(renderToStaticMarkup(<Icon />), new RegExp(`data-mark="${priority === 'urgent' ? 'urgent' : `bars-${priority === 'high' ? 3 : priority === 'normal' ? 2 : 1}`}"`))
  }
})

test('StateMark draws a status through the resolver', () => {
  const markup = renderToStaticMarkup(<StateMark state="doing" />)
  assert.match(markup, /data-task-status="doing"/)
  assert.match(markup, new RegExp(markToneClass[ISSUE_STATUS_MARKS.doing.tone]))
  assert.equal(stateMarkTone(ISSUE_STATUS_MARKS.doing), 'warning')
})
