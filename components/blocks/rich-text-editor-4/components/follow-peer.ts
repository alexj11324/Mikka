import { useEffect, useLayoutEffect, type RefObject } from "react"
import { isChangeOrigin } from "@tiptap/extension-collaboration"
import type { Editor } from "@tiptap/react"

// Keys that scroll the page; outside a field they end following.
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", " "])

/** The header's height differs per style and wraps on phones, so the margin
 * and the caret's scroll inset follow its measured size. */
export function useHeaderInsets(
  rootRef: RefObject<HTMLElement | null>,
  headerRef: RefObject<HTMLElement | null>,
  editor: Editor | null
) {
  useLayoutEffect(() => {
    const root = rootRef.current
    const header = headerRef.current
    if (!root || !header) return

    let height = header.getBoundingClientRect().height

    function applyInsets() {
      root?.style.setProperty("--spec-header", `${Math.round(height)}px`)
      // isDestroyed is true until the view mounts, and setProps needs the view.
      if (!editor || editor.isDestroyed) return
      editor.view.setProps({
        scrollThreshold: { top: height + 8, right: 0, bottom: 32, left: 0 },
        scrollMargin: { top: height + 24, right: 0, bottom: 48, left: 0 },
      })
    }

    applyInsets()
    editor?.on("mount", applyInsets)

    const observer = new ResizeObserver(([entry]) => {
      height =
        entry?.borderBoxSize[0]?.blockSize ??
        header.getBoundingClientRect().height
      applyInsets()
    })
    observer.observe(header)

    return () => {
      observer.disconnect()
      editor?.off("mount", applyInsets)
    }
  }, [rootRef, headerRef, editor])
}

interface FollowPeerOptions {
  editor: Editor | null
  /** The followed teammate's Awareness id; their caret carries data-peer. */
  followed: string | null
  rootRef: RefObject<HTMLElement | null>
  headerRef: RefObject<HTMLElement | null>
  /** Must be stable: an effect dependency. */
  onStop: () => void
}

/** Keeps the followed caret in the band below the header. Only your own
 * intent lets go: a wheel, a touch, a click on the page, keys, typing. */
export function useFollowPeer({
  editor,
  followed,
  rootRef,
  headerRef,
  onStop,
}: FollowPeerOptions) {
  useEffect(() => {
    if (!editor || !followed) return
    const view = editor.view
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches

    function keep() {
      const caret = view.dom.querySelector<HTMLElement>(
        `[data-peer="${CSS.escape(followed ?? "")}"]`
      )
      const header = headerRef.current
      if (!caret || !header) return
      const box = caret.getBoundingClientRect()
      const top = header.getBoundingClientRect().bottom + 24
      if (box.top >= top && box.bottom <= window.innerHeight - 48) return
      caret.scrollIntoView({
        block: "center",
        behavior: reduce ? "auto" : "smooth",
      })
    }

    function onTransaction({
      transaction,
    }: {
      transaction: Parameters<typeof isChangeOrigin>[0]
    }) {
      if (transaction.docChanged && !isChangeOrigin(transaction)) {
        onStop()
        return
      }
      keep()
    }

    function onKey(event: KeyboardEvent) {
      const target = event.target
      const inField =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea"))
      if (event.key === "Escape" || (!inField && SCROLL_KEYS.has(event.key))) {
        onStop()
      }
    }

    // Scroll events are never read: scroll anchoring and a slow smooth scroll
    // fire them too. The header and portaled menus keep the follow.
    function onPointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node) || !rootRef.current?.contains(target))
        return
      if (!headerRef.current?.contains(target)) onStop()
    }

    editor.on("transaction", onTransaction)
    window.addEventListener("wheel", onStop, { passive: true })
    window.addEventListener("touchmove", onStop, { passive: true })
    window.addEventListener("keydown", onKey)
    window.addEventListener("pointerdown", onPointerDown)
    keep()

    return () => {
      editor.off("transaction", onTransaction)
      window.removeEventListener("wheel", onStop)
      window.removeEventListener("touchmove", onStop)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pointerdown", onPointerDown)
    }
  }, [editor, followed, rootRef, headerRef, onStop])
}