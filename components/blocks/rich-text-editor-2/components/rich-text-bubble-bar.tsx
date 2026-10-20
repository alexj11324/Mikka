import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react"
import type { Editor } from "@tiptap/react"

import { Card } from "@/components/ui/card"

import { RichTextToolbar } from "./rich-text-toolbar"

const FIRST_STOP = "[data-toolbar-item][tabindex='0']"
const ANY_STOP = "[data-toolbar-item]:not([disabled]):not([data-disabled])"

/** Asks a bubble plugin to show or hide its menu now. */
export function setRichTextBubble(
  editor: Editor,
  pluginKey: string,
  action: "show" | "hide"
) {
  const { view } = editor

  view.dispatch(view.state.tr.setMeta(pluginKey, action))
  if (action === "show") {
    view.dispatch(view.state.tr.setMeta(pluginKey, "updatePosition"))
  }
}

// Menus and popovers portal out, yet React still bubbles their events here.
function fromOwnDom(event: { target: EventTarget; currentTarget: Element }) {
  return (
    event.target instanceof Node && event.currentTarget.contains(event.target)
  )
}

interface RichTextBubbleBarProps {
  editor: Editor
  pluginKey: string
  label: string
  /** Keeps the bar up while a field of its own holds focus. */
  holdOpen?: boolean
  children: ReactNode
}

/** The card a floating bar sits on: Alt+F10 reaches it from the text, Escape
 * goes back, and it lets go of its bubble once focus has left both. */
export function RichTextBubbleBar({
  editor,
  pluginKey,
  label,
  holdOpen = false,
  children,
}: RichTextBubbleBarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const holdRef = useRef(holdOpen)
  const pressingRef = useRef(false)

  useLayoutEffect(() => {
    holdRef.current = holdOpen
  }, [holdOpen])

  useEffect(() => {
    const { dom } = editor.view

    function release() {
      pressingRef.current = false
    }

    // A blur during a press on the bar is the bar's own doing. Any other blur
    // lets the bar go, since a press it took earlier latched the plugin's guard.
    function handleBlur({ event }: { event: FocusEvent }) {
      const pressed = pressingRef.current
      const next = event.relatedTarget

      queueMicrotask(() => {
        const bar = barRef.current

        if (editor.isDestroyed || !bar) return
        if (holdRef.current) {
          setRichTextBubble(editor, pluginKey, "show")
          return
        }
        if (pressed || !bar.isConnected || editor.view.hasFocus()) return

        const staysNear =
          (next instanceof Node && bar.parentElement?.contains(next)) ||
          bar.querySelector("[aria-expanded='true']") !== null

        if (!staysNear) setRichTextBubble(editor, pluginKey, "hide")
      })
    }

    // The WAI-ARIA editor convention; only a bar on screen is connected.
    function handleShortcut(event: KeyboardEvent) {
      const bar = barRef.current

      if (!event.altKey || event.key !== "F10" || !bar?.isConnected) return

      const stop =
        bar.querySelector<HTMLElement>(FIRST_STOP) ??
        bar.querySelector<HTMLElement>(ANY_STOP)

      if (!stop) return
      event.preventDefault()
      stop.focus()
    }

    editor.on("blur", handleBlur)
    dom.addEventListener("keydown", handleShortcut)
    document.addEventListener("pointerup", release, true)
    document.addEventListener("pointercancel", release, true)
    return () => {
      editor.off("blur", handleBlur)
      dom.removeEventListener("keydown", handleShortcut)
      document.removeEventListener("pointerup", release, true)
      document.removeEventListener("pointercancel", release, true)
    }
  }, [editor, pluginKey])

  // A menu that opens on pointerdown cancels the mousedown a bubble listens
  // for to survive the focus move, so a press on the bar itself is replayed.
  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!fromOwnDom(event)) return

    pressingRef.current = true
    event.currentTarget.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true })
    )
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !fromOwnDom(event)) return

    event.preventDefault()
    editor.commands.focus()
  }

  return (
    <Card
      ref={barRef}
      size="sm"
      className="p-1"
      onPointerDownCapture={handlePointerDown}
      onKeyDown={handleKeyDown}
    >
      <RichTextToolbar aria-label={label} aria-keyshortcuts="Alt+F10">
        {children}
      </RichTextToolbar>
    </Card>
  )
}