import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SyntheticEvent,
} from "react"
import { NodeSelection, Selection, type Transaction } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import type { Editor } from "@tiptap/react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  ACTIVE_BLOCK_KEY,
  blockCommand,
  blockTargetAtPos,
  findBlockTarget,
  insertBlockRow,
  isListItem,
  registerBlockMenuOpener,
  selectionBlockTarget,
  type ActiveBlock,
  type BlockTarget,
} from "./rich-text-block-actions"
import {
  blockMenuSelection,
  readBlockMenu,
  RichTextBlockMenuItems,
  type BlockMenuState,
} from "./rich-text-block-menu"
import { keepEditorFocus, ShortcutKeys } from "./rich-text-toolbar"
import { PlusIcon, GripVerticalIcon } from "lucide-react"

// Room between the gutter and the text, and how far below the last row a
// pointer still counts as on it (the widest gap between blocks is 40px).
const GUTTER_GAP = 4
const ROW_REACH = 48
// Tailwind's sm: below it the gutter is not laid out.
const SM_QUERY = "(min-width: 40rem)"

/** The block on the row under clientY, probed just inside the text's edge so
 * a pointer over the gutter still finds its row. */
function blockTargetAtY(view: EditorView, clientY: number) {
  const box = view.dom.getBoundingClientRect()
  if (clientY < box.top || clientY > box.bottom) return null
  const hit = view.posAtCoords({ left: box.left + 2, top: clientY })
  if (!hit) return null
  const { doc } = view.state
  const inner = hit.inside >= 0 ? doc.nodeAt(hit.inside) : null
  const target = findBlockTarget(
    doc,
    inner?.isAtom && inner.isBlock ? hit.inside : hit.pos
  )
  const block = target ? view.nodeDOM(target.pos) : null
  if (!target || !(block instanceof HTMLElement)) return null

  // Below the last row the probe still lands on it, however far down.
  const bottom = block.getBoundingClientRect().bottom
  return clientY - bottom > ROW_REACH ? null : target
}

/** Viewport y of the middle of the block's first line. */
function firstLineCenter(
  view: EditorView,
  target: BlockTarget,
  block: HTMLElement
) {
  let line: HTMLElement = block

  if (target.node.type.spec.tableRole) {
    line = block.querySelector<HTMLElement>("tr") ?? block
  } else if (target.node.isAtom) {
    line = block.querySelector<HTMLElement>("p") ?? block
  } else if (!target.node.isTextblock) {
    let textPos = -1
    target.node.descendants((child, offset) => {
      if (textPos < 0 && child.isTextblock) textPos = target.pos + 1 + offset
      return textPos < 0
    })
    const inner = textPos >= 0 ? view.nodeDOM(textPos) : null
    if (inner instanceof HTMLElement) line = inner
  }

  const rect = line.getBoundingClientRect()
  const style = getComputedStyle(line)
  const lineHeight = parseFloat(style.lineHeight)

  // Table rows, rules and unset line heights center on the box instead.
  if (line.tagName === "TR" || !(rect.height >= lineHeight)) {
    return rect.top + rect.height / 2
  }
  const inset = parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth)
  return rect.top + inset + lineHeight / 2
}

/** Where the gutter sits in the scroller: left of the row, on its first line. */
function gutterPoint(
  view: EditorView,
  target: BlockTarget,
  scroller: HTMLElement,
  gutter: HTMLElement
) {
  const block = view.nodeDOM(target.pos)
  if (!(block instanceof HTMLElement)) return null
  // A list item lines up with its own list, so the gutter clears the marker.
  const edge = isListItem(target.node) ? block.parentElement : view.dom
  const left = (edge ?? block).getBoundingClientRect().left
  const box = scroller.getBoundingClientRect()
  const x = left - box.left + scroller.scrollLeft - GUTTER_GAP
  const y = firstLineCenter(view, target, block) - box.top + scroller.scrollTop

  return {
    x: Math.round(Math.max(x, gutter.offsetWidth)),
    y: Math.round(y),
  }
}

/** dragstart on the grip: it sits outside the editor, so ProseMirror's own
 * dragstart never runs and everything it would set is set here. */
function startBlockDrag(
  view: EditorView,
  target: BlockTarget,
  event: DragEvent
) {
  const data = event.dataTransfer
  if (!data || !view.editable) return undefined
  const selection = NodeSelection.create(view.state.doc, target.pos)
  const { dom, text, slice } = view.serializeForClipboard(selection.content())

  data.clearData()
  data.setData("text/html", dom.innerHTML)
  data.setData("text/plain", text)
  data.effectAllowed = "copyMove"
  const block = view.nodeDOM(target.pos)
  if (block instanceof HTMLElement) {
    const rect = block.getBoundingClientRect()
    const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height)
    data.setDragImage(block, 0, y)
  }

  // Through a variable: the public type omits node, which the drop reads.
  const dragging = { slice, move: true, node: selection }
  view.dragging = dragging
  // After the browser snapshots the drag image, so the ghost is not faded.
  window.setTimeout(() => {
    if (view.isDestroyed || view.dragging !== dragging) return
    const mark = { pos: dragging.node.from, kind: "drag" } satisfies ActiveBlock
    view.dispatch(view.state.tr.setMeta(ACTIVE_BLOCK_KEY, mark))
  }, 0)
  return dragging
}

/** dragend fires on the grip, never on the editor, so a drop outside the
 * page or Escape would leave the drag state behind without this. */
function endBlockDrag(view: EditorView, dragging: object | undefined) {
  if (view.isDestroyed) return
  if (dragging && view.dragging === dragging) view.dragging = null
  if (ACTIVE_BLOCK_KEY.getState(view.state)?.kind === "drag") {
    view.dispatch(view.state.tr.setMeta(ACTIVE_BLOCK_KEY, null))
  }
}

// Keeps a press on the grip from opening the menu, so it can start a drag;
// the menu opens on click instead, which never follows a drag.
function holdPress(event: SyntheticEvent) {
  event.stopPropagation()
}

interface RichTextBlockGutterProps {
  editor: Editor
  editable: boolean
  /** The relative box the gutter is positioned in; it may scroll itself or move
   *  with a page that its host scrolls. */
  scrollerRef: RefObject<HTMLDivElement | null>
  /** Tables confirm before they go. */
  onDeleteTable: () => void
}

export function RichTextBlockGutter({
  editor,
  editable,
  scrollerRef,
  onDeleteTable,
}: RichTextBlockGutterProps) {
  const [shown, setShown] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menu, setMenu] = useState<BlockMenuState | null>(null)
  const [tipOpen, setTipOpen] = useState(false)
  const gutterRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef<number | null>(null)
  const shownRef = useRef(false)
  const menuRef = useRef(false)
  const dragRef = useRef<object | undefined>(undefined)
  const pointerRef = useRef<number | null>(null)
  const followRef = useRef<(() => void) | null>(null)
  const openMenuRef = useRef(openMenu)
  const visible = editable && ((shown && !dragging) || menuOpen)

  function openMenu(pos: number | null) {
    const target = pos === null ? null : blockTargetAtPos(editor.state.doc, pos)
    if (menuRef.current || !target) return
    menuRef.current = true
    const { view } = editor
    const selection = blockMenuSelection(editor, target)
    const mark = { pos: target.pos, kind: "menu" } satisfies ActiveBlock
    const tr = view.state.tr.setMeta(ACTIVE_BLOCK_KEY, mark)
    view.dispatch(selection ? tr.setSelection(selection) : tr)

    // Read after the caret moved in, so each option is checked on this block.
    setTipOpen(false)
    setMenu(readBlockMenu(editor, target))
    setMenuOpen(true)
  }

  function handleMenuOpenChange(open: boolean) {
    if (open) {
      openMenu(targetRef.current)
      return
    }
    menuRef.current = false
    setMenuOpen(false)
    const { view } = editor
    if (ACTIVE_BLOCK_KEY.getState(view.state)?.kind === "menu") {
      view.dispatch(view.state.tr.setMeta(ACTIVE_BLOCK_KEY, null))
    }
    followRef.current?.()
  }

  // The editor subscription below opens the menu through the latest handler.
  useEffect(() => {
    openMenuRef.current = openMenu
  })

  useEffect(() => {
    const scroller = scrollerRef.current
    const gutter = gutterRef.current
    if (!scroller || !gutter) return
    const { view } = editor
    const fine = window.matchMedia("(pointer: fine)")
    const wide = window.matchMedia(SM_QUERY)
    let lastX = -1
    let lastY = -1

    function show(next: boolean) {
      if (shownRef.current === next) return
      shownRef.current = next
      setShown(next)
    }

    // Moves the gutter beside the target; force re-measures the same one.
    function place(target: BlockTarget | null, force: boolean) {
      if (!scroller || !gutter) return
      if (!target || !view.editable) {
        targetRef.current = null
        show(false)
        return
      }
      if (!force && shownRef.current && targetRef.current === target.pos) {
        return
      }
      const point = gutterPoint(view, target, scroller, gutter)
      if (!point) return show(false)
      targetRef.current = target.pos
      gutter.style.transform = `translate(${point.x}px, ${point.y}px)`
      show(true)
    }

    // Held still while the menu is open or a drag runs.
    function follow(force = true) {
      if (menuRef.current || dragRef.current) return
      if (fine.matches) {
        const y = pointerRef.current
        place(y === null ? null : blockTargetAtY(view, y), force)
      } else {
        place(view.hasFocus() ? selectionBlockTarget(view.state) : null, force)
      }
    }
    followRef.current = follow

    function handlePointerMove(event: PointerEvent) {
      if (event.pointerType === "touch") return
      if (event.clientX === lastX && event.clientY === lastY) return
      lastX = event.clientX
      lastY = event.clientY
      pointerRef.current = event.clientY
      follow(false)
    }

    function handlePointerLeave() {
      pointerRef.current = null
      follow()
    }

    // Typing hides the gutter until the pointer moves again.
    function handleKeyDown(event: KeyboardEvent) {
      if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) return
      pointerRef.current = null
      follow()
    }

    // Mod-/: the menu hangs off the grip, which is not laid out below sm.
    function openFromShortcut() {
      const target = selectionBlockTarget(view.state)
      if (!wide.matches || !target) return false
      place(target, true)
      openMenuRef.current(target.pos)
      return true
    }

    // A press beside a row lands in that row; the kit's inset handler would
    // send the caret to the end of the page.
    function handleInsetPress(event: MouseEvent) {
      const box = view.dom.getBoundingClientRect()
      const onInset =
        event.target === scroller || event.target === view.dom.parentElement
      if (!onInset || event.button !== 0 || !view.editable) return
      if (event.clientY < box.top || event.clientY > box.bottom) return
      const left = Math.min(
        Math.max(event.clientX, box.left + 1),
        box.right - 1
      )
      const hit = view.posAtCoords({ left, top: event.clientY })
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setSelection(Selection.near(tr.doc.resolve(hit.pos)))
          return true
        })
        .run()
    }

    function handleTransaction({ transaction }: { transaction: Transaction }) {
      if (!fine.matches && transaction.docChanged) return show(false)
      if (transaction.docChanged || !fine.matches) follow()
    }

    function handleBlur({ event }: { event: FocusEvent }) {
      const next = event.relatedTarget
      if (next instanceof Node && gutter?.contains(next)) return
      follow()
    }

    function handleScroll() {
      follow(false)
    }

    function refresh() {
      follow()
    }

    const observer = new ResizeObserver(refresh)
    observer.observe(scroller)
    observer.observe(view.dom)
    // The gutter is not laid out while hidden, so its width lands on first show.
    observer.observe(gutter)
    scroller.addEventListener("pointermove", handlePointerMove)
    scroller.addEventListener("pointerleave", handlePointerLeave)
    scroller.addEventListener("scroll", handleScroll, { passive: true })
    scroller.addEventListener("mousedown", handleInsetPress, true)
    view.dom.addEventListener("keydown", handleKeyDown)
    editor.on("transaction", handleTransaction)
    editor.on("focus", refresh)
    editor.on("blur", handleBlur)
    const unregister = registerBlockMenuOpener(editor, openFromShortcut)

    return () => {
      followRef.current = null
      unregister()
      observer.disconnect()
      scroller.removeEventListener("pointermove", handlePointerMove)
      scroller.removeEventListener("pointerleave", handlePointerLeave)
      scroller.removeEventListener("scroll", handleScroll)
      scroller.removeEventListener("mousedown", handleInsetPress, true)
      view.dom.removeEventListener("keydown", handleKeyDown)
      editor.off("transaction", handleTransaction)
      editor.off("focus", refresh)
      editor.off("blur", handleBlur)
    }
  }, [editor, scrollerRef])

  function insertRow(event: ReactMouseEvent) {
    const pos = targetRef.current
    if (pos === null) return
    const row = blockCommand(
      insertBlockRow(event.altKey ? "before" : "after"),
      pos
    )
    // A chain runs every step, so a refused row would type "/" at the caret.
    if (!editor.can().command(row)) return
    // Typing "/" opens the slash menu there, as on any empty line.
    editor.chain().focus().command(row).insertContent("/").run()
    pointerRef.current = null
    followRef.current?.()
  }

  function handleDragStart(event: ReactDragEvent<HTMLButtonElement>) {
    const pos = targetRef.current
    const target = pos === null ? null : blockTargetAtPos(editor.state.doc, pos)
    const started = target
      ? startBlockDrag(editor.view, target, event.nativeEvent)
      : undefined
    if (!started) return event.preventDefault()
    dragRef.current = started
    // Next task: nothing on the drag source changes while the drag starts.
    window.setTimeout(() => {
      if (dragRef.current !== started) return
      setTipOpen(false)
      setDragging(true)
    }, 0)
  }

  function handleDragEnd() {
    endBlockDrag(editor.view, dragRef.current)
    dragRef.current = undefined
    setDragging(false)
    pointerRef.current = null
    followRef.current?.()
  }

  return (
    <div
      ref={gutterRef}
      data-visible={visible ? "" : undefined}
      data-present={visible || dragging ? "" : undefined}
      inert={!visible && !dragging}
      className="pointer-events-none absolute top-0 left-0 z-10 hidden -translate-x-full -translate-y-1/2 items-center gap-0.5 opacity-0 transition-[opacity,display] transition-discrete duration-150 ease-out data-visible:pointer-events-auto data-visible:opacity-100 motion-reduce:transition-none data-present:sm:flex data-visible:starting:opacity-0"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              aria-label="Add block"
              onMouseDown={keepEditorFocus}
              onClick={insertRow}
              className="text-muted-foreground"
            />
          }
        >
          <PlusIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>
          <span className="flex flex-col items-start gap-0.5">
            <span>Add block below</span>
            <span className="flex items-center gap-1.5">
              Add above
              <ShortcutKeys keys={["alt", "Click"]} />
            </span>
          </span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <Tooltip
          open={tipOpen && !dragging && !menuOpen}
          onOpenChange={setTipOpen}
        >
          <TooltipTrigger
            render={
              <span
                className="flex"
                onPointerDownCapture={holdPress}
                onMouseDownCapture={holdPress}
              />
            }
          >
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  draggable
                  aria-label="Block actions"
                  onClick={() =>
                    menuOpen
                      ? handleMenuOpenChange(false)
                      : openMenu(targetRef.current)
                  }
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  className="text-muted-foreground cursor-grab active:cursor-grabbing"
                />
              }
            >
              <GripVerticalIcon aria-hidden="true" />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <span className="flex flex-col items-start gap-0.5">
              <span>Drag to reorder</span>
              <span className="flex items-center gap-1.5">
                Block actions
                <ShortcutKeys keys={["mod", "/"]} />
              </span>
            </span>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          className="w-52"
          finalFocus={() => editor.view.dom}
        >
          {menu ? (
            <RichTextBlockMenuItems
              editor={editor}
              menu={menu}
              onDeleteTable={onDeleteTable}
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}