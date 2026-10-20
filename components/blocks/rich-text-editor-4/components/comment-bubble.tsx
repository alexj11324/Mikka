import { useCallback } from "react"
import type { EditorState } from "@tiptap/pm/state"
import { isTextSelection, type Editor } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"

import { Button } from "@/components/ui/button"
import { RichTextBubbleBar } from "./rich-text-bubble-bar"
import { canAnchorComment } from "./rich-text-comments"
import { keepEditorFocus } from "./rich-text-toolbar"
import { MessageSquareTextIcon } from "lucide-react"

const COMMENT_BUBBLE_KEY = "specCommentBubble"

const COMMENT_BUBBLE_OPTIONS = { placement: "top", offset: 8 } as const

interface ShouldShowProps {
  editor: Editor
  element: HTMLElement
  state: EditorState
}

interface CommentBubbleProps {
  editor: Editor
  /** Open threads block a new anchor; resolved ones yield. Must be stable. */
  isOpen: (id: string) => boolean
  onComment: () => void
}

/** One action over a fresh selection: start a thread on it. */
export function CommentBubble({
  editor,
  isOpen,
  onComment,
}: CommentBubbleProps) {
  // Stable identity: a new function would re-register the plugin options.
  const shouldShow = useCallback(
    ({ editor: current, element, state }: ShouldShowProps) => {
      if (!isTextSelection(state.selection)) return false
      // Code and links have bars of their own at the same spot.
      if (current.isActive("codeBlock") || current.isActive("link")) {
        return false
      }
      if (!canAnchorComment(current, isOpen)) return false
      return current.view.hasFocus() || element.contains(document.activeElement)
    },
    [isOpen]
  )

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={COMMENT_BUBBLE_KEY}
      shouldShow={shouldShow}
      options={COMMENT_BUBBLE_OPTIONS}
      className="z-50"
    >
      <RichTextBubbleBar
        editor={editor}
        pluginKey={COMMENT_BUBBLE_KEY}
        label="Selection"
      >
        <Button
          variant="ghost"
          size="sm"
          data-toolbar-item=""
          onMouseDown={keepEditorFocus}
          onClick={onComment}
        >
          <MessageSquareTextIcon aria-hidden="true" />
          Comment
        </Button>
      </RichTextBubbleBar>
    </BubbleMenu>
  )
}