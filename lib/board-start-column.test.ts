import assert from 'node:assert/strict'
import test from 'node:test'
import { boardScrollTo, boardStartColumn } from './board-start-column'

test('a board opens on the first shown column that has a task', () => {
  const shown = ['triage', 'todo', 'in_progress', 'done']
  assert.equal(boardStartColumn(shown, { triage: 0, todo: 3, in_progress: 1 }), 'todo')
  assert.equal(boardStartColumn(shown, { triage: 0, todo: 0, in_progress: 2 }), 'in_progress')
  assert.equal(boardStartColumn(shown, { triage: 1, todo: 3 }), null, 'the first column already has tasks')
  assert.equal(boardStartColumn(shown, {}), null, 'an empty board stays where it is')
  assert.equal(boardStartColumn([], { todo: 1 }), null)
})

test('the board scrolls only when that column is not already in full view', () => {
  // Desktop: the second column is on screen already.
  assert.equal(boardScrollTo({ left: 320, right: 620 }, { left: 0, right: 1100 }, 0), null)
  // Phone: the second column starts past the right edge.
  assert.equal(boardScrollTo({ left: 316, right: 616 }, { left: 16, right: 390 }, 0), 300)
  assert.equal(boardScrollTo({ left: 400, right: 700 }, { left: 0, right: 390 }, 50), 450)
})
