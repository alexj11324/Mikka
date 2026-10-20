import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model"
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state"
import { dropPoint } from "@tiptap/pm/transform"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import { Extension, type Command, type Editor } from "@tiptap/react"

/** A block the gutter acts on: a top-level block or one list item. */
export interface BlockTarget {
  /** Position right before the node. */
  pos: number
  node: ProseMirrorNode
  depth: number
  /** Index among the parent's children. */
  index: number
  parent: ProseMirrorNode
}

type BlockAction = (
  state: EditorState,
  target: BlockTarget
) => Transaction | null

const LIST_ITEMS = new Set(["listItem", "taskItem"])

/** The block being dragged, or the one the block menu acts on. */
export interface ActiveBlock {
  pos: number
  kind: "drag" | "menu"
}

/** Holds the active block; set and cleared through transaction meta. */
export const ACTIVE_BLOCK_KEY = new PluginKey<ActiveBlock | null>(
  "richTextActiveBlock"
)

// Dragging fades the block; the menu paints its text like a selection.
const ACTIVE_BLOCK_CLASS = { drag: "opacity-50", menu: "selection" } as const

// The gutter registers here what Mod-/ opens; false leaves the key alone.
const menuOpeners = new WeakMap<Editor, () => boolean>()

export function registerBlockMenuOpener(editor: Editor, open: () => boolean) {
  menuOpeners.set(editor, open)
  return () => {
    if (menuOpeners.get(editor) === open) menuOpeners.delete(editor)
  }
}

function targetAt($pos: ResolvedPos, depth: number): BlockTarget {
  return {
    pos: $pos.before(depth),
    node: $pos.node(depth),
    depth,
    index: $pos.index(depth - 1),
    parent: $pos.node(depth - 1),
  }
}

/** The block that owns a position: the innermost list item, else the
 * top-level block; anything inside a table resolves to the table. */
export function findBlockTarget(
  doc: ProseMirrorNode,
  pos: number
): BlockTarget | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))

  // Between top-level blocks (an atom, the gap around a table): the next one.
  if ($pos.depth === 0) {
    const node = $pos.nodeAfter ?? $pos.nodeBefore
    if (!node) return null
    const at = $pos.nodeAfter ? $pos.pos : $pos.pos - node.nodeSize
    return blockTargetAtPos(doc, at)
  }

  let depth = 1
  for (let level = 2; level <= $pos.depth; level++) {
    const node = $pos.node(level)
    if (node.type.spec.tableRole) break
    if (LIST_ITEMS.has(node.type.name)) depth = level
  }
  return targetAt($pos, depth)
}

/** Re-reads a target from its position after the document changed. */
export function blockTargetAtPos(
  doc: ProseMirrorNode,
  pos: number
): BlockTarget | null {
  if (pos < 0 || pos >= doc.content.size) return null
  const node = doc.nodeAt(pos)
  if (!node || !node.isBlock) return null
  const $pos = doc.resolve(pos)

  return {
    pos,
    node,
    depth: $pos.depth + 1,
    index: $pos.index(),
    parent: $pos.parent,
  }
}

/** The block that holds the selection; the shortcuts act on this one. */
export function selectionBlockTarget(state: EditorState): BlockTarget | null {
  const { selection, doc } = state

  if (selection instanceof NodeSelection) {
    const { node, from } = selection
    if (LIST_ITEMS.has(node.type.name) || selection.$from.depth === 0) {
      return blockTargetAtPos(doc, from)
    }
    return findBlockTarget(doc, node.isLeaf ? from : from + 1)
  }
  return findBlockTarget(doc, selection.from)
}

export function isListItem(node: ProseMirrorNode) {
  return LIST_ITEMS.has(node.type.name)
}

/** The block's own text: a list item's first line, else every line. */
export function blockTextRange({ node, pos }: BlockTarget) {
  if (node.isTextblock)
    return { from: pos + 1, to: pos + 1 + node.content.size }
  if (node.isAtom || node.type.spec.tableRole) return null
  let from = -1
  let to = -1

  node.descendants((child, offset) => {
    if (from >= 0 && isListItem(node)) return false
    if (!child.isTextblock) return true
    const start = pos + 2 + offset
    if (from < 0) from = start
    to = start + child.content.size
    return false
  })
  return from < 0 ? null : { from, to }
}

function isEmptyParagraph(node: ProseMirrorNode) {
  return node.type.name === "paragraph" && node.childCount === 0
}

/** Keeps the selection at the same spot inside a block that moved to newPos. */
function carryAcross(
  tr: Transaction,
  state: EditorState,
  target: BlockTarget,
  newPos: number
) {
  const { selection } = state
  const end = target.pos + target.node.nodeSize

  if (selection instanceof NodeSelection && selection.from === target.pos) {
    return tr.setSelection(NodeSelection.create(tr.doc, newPos))
  }
  if (selection.from >= target.pos && selection.to <= end) {
    const shift = newPos - target.pos
    return tr.setSelection(
      TextSelection.between(
        tr.doc.resolve(selection.anchor + shift),
        tr.doc.resolve(selection.head + shift)
      )
    )
  }
  return tr
}

/** Caret on the first text inside the node at `at`, else the node itself. */
function selectBlockStart(tr: Transaction, at: number, node: ProseMirrorNode) {
  const found = node.isAtom
    ? null
    : Selection.findFrom(tr.doc.resolve(at + 1), 1, true)

  if (found && found.from < at + node.nodeSize) return tr.setSelection(found)
  return tr.setSelection(NodeSelection.create(tr.doc, at))
}

/** What removing the block takes: an only child takes its wrapper too. */
function removalRange(doc: ProseMirrorNode, target: BlockTarget) {
  const $pos = doc.resolve(target.pos)
  let depth = target.depth
  while (depth > 1 && $pos.node(depth - 1).childCount === 1) depth--
  if (depth === target.depth) {
    return { from: target.pos, to: target.pos + target.node.nodeSize, depth }
  }
  return { from: $pos.before(depth), to: $pos.after(depth), depth }
}

export function canMoveBlock(target: BlockTarget, dir: -1 | 1) {
  return dir < 0
    ? target.index > 0
    : target.index < target.parent.childCount - 1
}

/** Swaps the block with its previous or next sibling in one step. */
function moveBlock(state: EditorState, target: BlockTarget, dir: -1 | 1) {
  if (!canMoveBlock(target, dir)) return null
  const { pos, node, parent, index } = target
  const sibling = parent.child(index + dir)
  const tr = state.tr

  if (dir < 0) {
    const from = pos - sibling.nodeSize
    tr.replaceWith(from, pos + node.nodeSize, [node, sibling])
    return carryAcross(tr, state, target, from).scrollIntoView()
  }
  tr.replaceWith(pos, pos + node.nodeSize + sibling.nodeSize, [sibling, node])
  return carryAcross(tr, state, target, pos + sibling.nodeSize).scrollIntoView()
}

export const moveBlockUp: BlockAction = (state, target) =>
  moveBlock(state, target, -1)

export const moveBlockDown: BlockAction = (state, target) =>
  moveBlock(state, target, 1)

/** Inserts a copy right after the block and moves the selection into it. */
export const duplicateBlock: BlockAction = (state, target) => {
  const at = target.pos + target.node.nodeSize
  const tr = state.tr.insert(at, target.node)
  const { selection } = state
  const inside =
    selection.from >= target.pos &&
    selection.to <= target.pos + target.node.nodeSize

  if (inside) return carryAcross(tr, state, target, at).scrollIntoView()
  return selectBlockStart(tr, at, target.node).scrollIntoView()
}

/** Removes the block; an only child takes its now-empty wrapper with it. */
export const deleteBlock: BlockAction = (state, target) => {
  const { from, to, depth } = removalRange(state.doc, target)
  const tr = state.tr

  if (depth === 1 && state.doc.childCount === 1) {
    tr.replaceWith(
      0,
      state.doc.content.size,
      state.schema.nodes.paragraph.create()
    )
  } else {
    tr.delete(from, to)
  }
  const $at = tr.doc.resolve(Math.min(from, tr.doc.content.size))
  // The caret lands at the end of the block above, else the start of the next.
  const selection =
    Selection.findFrom($at, -1, true) ??
    Selection.findFrom($at, 1, true) ??
    Selection.near($at)
  return tr.setSelection(selection).scrollIntoView()
}

/** An empty row above or below the block with the caret in it: a paragraph,
 * or an item where only items fit; an empty row is reused, never doubled. */
export function insertBlockRow(side: "before" | "after"): BlockAction {
  return (state, target) => {
    const tr = state.tr
    const { node, parent, pos } = target
    const first = node.firstChild

    if (isEmptyParagraph(node)) {
      return tr.setSelection(TextSelection.create(tr.doc, pos + 1))
    }
    if (isListItem(node) && node.childCount === 1 && first) {
      if (isEmptyParagraph(first)) {
        return tr.setSelection(TextSelection.create(tr.doc, pos + 2))
      }
    }

    const index = side === "before" ? target.index : target.index + 1
    const paragraph = state.schema.nodes.paragraph
    const row = parent.canReplaceWith(index, index, paragraph)
      ? paragraph.create()
      : node.type.createAndFill()
    if (!row) return null

    const at = side === "before" ? pos : pos + node.nodeSize
    tr.insert(at, row)
    return selectBlockStart(tr, at, row).scrollIntoView()
  }
}

/** Runs an action on the block at pos, or on the caret's block without one. */
export function blockCommand(action: BlockAction, pos?: number): Command {
  return ({ state }) => {
    const target =
      pos === undefined
        ? selectionBlockTarget(state)
        : blockTargetAtPos(state.doc, pos)

    return target ? action(state, target) !== null : false
  }
}

/** True when a drop would put the block back where it already is. */
function isDropOnSelf(
  doc: ProseMirrorNode,
  dragPos: number,
  insertPos: number
) {
  const node = doc.nodeAt(dragPos)
  return node
    ? insertPos >= dragPos && insertPos <= dragPos + node.nodeSize
    : false
}

/** Where an item dropped beside a list of its kind joins it: that list's
 * end, else its start; null where the stock drop already lands it right. */
function listEdge(doc: ProseMirrorNode, at: number, item: ProseMirrorNode) {
  const holds = (list: ProseMirrorNode | null | undefined) =>
    !!list &&
    !list.isTextblock &&
    list.canReplaceWith(list.childCount, list.childCount, item.type)
  const $at = doc.resolve(at)
  if (holds($at.parent)) return null

  let pos = at
  if ($at.parent.inlineContent && $at.depth > 0) {
    const early = $at.parentOffset * 2 <= $at.parent.content.size
    pos = early ? $at.before() : $at.after()
  }
  const $pos = doc.resolve(pos)
  if (holds($pos.nodeBefore)) return pos - 1
  if (holds($pos.nodeAfter)) return pos + 1
  return null
}

/** Moves a dragged list item into the list beside the drop point. */
function dropIntoList(view: EditorView, source: NodeSelection, at: number) {
  const { state } = view
  const edge = listEdge(state.doc, at, source.node)
  const target = blockTargetAtPos(state.doc, source.from)
  if (edge === null || !target) return false

  const { from, to } = removalRange(state.doc, target)
  const tr = state.tr.delete(from, to)
  const mapped = tr.mapping.mapResult(edge)
  // Back onto itself, or into the list it leaves empty: nothing to move.
  if (isDropOnSelf(state.doc, source.from, edge) || mapped.deleted) {
    view.dispatch(state.tr.setMeta(ACTIVE_BLOCK_KEY, null))
    return true
  }
  tr.insert(mapped.pos, source.node)
  selectBlockStart(tr, mapped.pos, source.node)
  view.focus()
  view.dispatch(tr.setMeta("uiEvent", "drop"))
  return true
}

export const RichTextBlockActions = Extension.create({
  name: "richTextBlockActions",

  addKeyboardShortcuts() {
    const run = (action: BlockAction) => () =>
      this.editor.commands.command(blockCommand(action))

    return {
      "Mod-Shift-ArrowUp": run(moveBlockUp),
      "Mod-Shift-ArrowDown": run(moveBlockDown),
      "Mod-d": run(duplicateBlock),
      "Mod-/": () =>
        this.editor.isEditable && (menuOpeners.get(this.editor)?.() ?? false),
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<ActiveBlock | null>({
        key: ACTIVE_BLOCK_KEY,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta: ActiveBlock | null | undefined =
              tr.getMeta(ACTIVE_BLOCK_KEY)
            if (meta !== undefined) return meta
            if (!value || tr.getMeta("uiEvent") === "drop") return null
            const mapped = tr.mapping.mapResult(value.pos)
            return mapped.deleted ? null : { ...value, pos: mapped.pos }
          },
        },
        props: {
          // Node decorations reach node views too, with no React render.
          decorations(state) {
            const active = ACTIVE_BLOCK_KEY.getState(state)
            const target = active
              ? blockTargetAtPos(state.doc, active.pos)
              : null
            if (!active || !target) return null
            const attrs = { class: ACTIVE_BLOCK_CLASS[active.kind] }
            const text = active.kind === "menu" ? blockTextRange(target) : null

            // The menu tints text only, so task checkboxes stay visible.
            return DecorationSet.create(state.doc, [
              text && text.to > text.from
                ? Decoration.inline(text.from, text.to, attrs)
                : Decoration.node(
                    target.pos,
                    target.pos + target.node.nodeSize,
                    attrs
                  ),
            ])
          },
          // Stock drops delete and reinsert, which records an empty undo step,
          // and drop an item beside its list into a new one-item list.
          handleDrop(view, event, slice, moved) {
            const { dragging } = view
            const source = dragging && "node" in dragging ? dragging.node : null
            if (!moved || !(source instanceof NodeSelection)) return false
            const hit = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            })
            if (!hit) return false
            const { doc } = view.state
            const at = dropPoint(doc, hit.pos, slice) ?? hit.pos
            if (isDropOnSelf(doc, source.from, at)) {
              view.dispatch(view.state.tr.setMeta(ACTIVE_BLOCK_KEY, null))
              return true
            }
            return isListItem(source.node) && dropIntoList(view, source, at)
          },
        },
      }),
    ]
  },
})