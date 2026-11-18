import assert from "node:assert/strict"
import { test } from "node:test"
import { Schema } from "@tiptap/pm/model"
import { EditorState } from "@tiptap/pm/state"

import {
  blockCommand,
  deleteBlock,
  duplicateBlock,
  insertBlockRow,
  moveBlockDown,
  moveBlockUp,
} from "./rich-text-block-actions"

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", group: "block" },
    text: { group: "inline" },
  },
})

function editorState(lines: string[]) {
  return EditorState.create({
    schema,
    doc: schema.nodes.doc.create(
      null,
      lines.map((line) =>
        schema.nodes.paragraph.create(null, line ? schema.text(line) : undefined)
      )
    ),
  })
}

function lines(state: EditorState) {
  const result: string[] = []
  state.doc.forEach((node) => result.push(node.textContent))
  return result
}

function apply(
  state: EditorState,
  action: Parameters<typeof blockCommand>[0],
  pos: number
) {
  const tr = state.tr
  const worked = blockCommand(action, pos)({ state, tr } as never)
  return { worked, next: state.apply(tr), tr }
}

test("moving a block uses the chain transaction, not a discarded state.tr", () => {
  const initial = editorState(["alpha", "beta"])
  const down = apply(initial, moveBlockDown, 0)
  assert.equal(down.worked, true)
  assert.deepEqual(lines(down.next), ["beta", "alpha"])
  assert.ok(down.tr.steps.length > 0)

  const secondPos = down.next.doc.child(0).nodeSize
  const up = apply(down.next, moveBlockUp, secondPos)
  assert.equal(up.worked, true)
  assert.deepEqual(lines(up.next), ["alpha", "beta"])
})

test("duplicate and delete act through the transaction the command receives", () => {
  const initial = editorState(["alpha", "beta"])
  const duplicate = apply(initial, duplicateBlock, 0)
  assert.equal(duplicate.worked, true)
  assert.deepEqual(lines(duplicate.next), ["alpha", "alpha", "beta"])

  const removed = apply(duplicate.next, deleteBlock, 0)
  assert.equal(removed.worked, true)
  assert.deepEqual(lines(removed.next), ["alpha", "beta"])
})

test("insert before/after chains a real paragraph into the current transaction", () => {
  const initial = editorState(["alpha", "beta"])
  const before = apply(initial, insertBlockRow("before"), 0)
  assert.equal(before.worked, true)
  assert.deepEqual(lines(before.next), ["", "alpha", "beta"])
  const after = apply(initial, insertBlockRow("after"), 0)
  assert.equal(after.worked, true)
  assert.deepEqual(lines(after.next), ["alpha", "", "beta"])
})

test("rejected block positions are false and do not change the transaction", () => {
  const initial = editorState(["alpha"])
  const { worked, next, tr } = apply(initial, moveBlockUp, 0)
  assert.equal(worked, false)
  assert.equal(tr.steps.length, 0)
  assert.deepEqual(lines(next), ["alpha"])
  const missing = apply(initial, duplicateBlock, initial.doc.content.size)
  assert.equal(missing.worked, false)
  assert.equal(missing.tr.steps.length, 0)
})

test("dry-run/can checks do not mutate the editor's persisted state", () => {
  const state = editorState(["alpha", "beta"])
  const probe = state.tr
  assert.equal(
    blockCommand(duplicateBlock, 0)({ state, tr: probe } as never),
    true
  )
  assert.deepEqual(lines(state), ["alpha", "beta"])
  assert.ok(probe.steps.length > 0)
})
