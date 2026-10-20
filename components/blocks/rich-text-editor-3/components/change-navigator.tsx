import { useState } from "react"
import type { Editor } from "@tiptap/react"
import { readChanges, type RichTextChangesPosition } from "./rich-text-changes"
import { RichTextButton, RichTextToolbarGroup } from "./rich-text-toolbar"
import { ChevronUpIcon, ChevronDownIcon } from "lucide-react"

interface ChangeNavigatorProps {
  editor: Editor | null
  position: RichTextChangesPosition
  onReveal: (id: string) => void
}

/** Steps through suggestions in document order, wrapping at both ends. */
export function ChangeNavigator({
  editor,
  position,
  onReveal,
}: ChangeNavigatorProps) {
  const { total, index } = position
  // Announced after a step only; the visible counter stays quiet while typing.
  const [announcement, setAnnouncement] = useState("")

  function step(direction: 1 | -1) {
    if (!editor || total === 0) return

    // Positions are read at the click, so typing never re-renders the stepper.
    const changes = readChanges(editor.state.doc)
    const count = changes.length
    let next = -1
    if (index !== -1) {
      next = (index + direction + count) % count
    } else {
      const { from, to } = editor.state.selection
      next =
        direction === 1
          ? changes.findIndex((change) => change.from >= to)
          : changes.findLastIndex((change) => change.to <= from)
      if (next === -1) next = direction === 1 ? 0 : count - 1
    }

    const target = changes[next]
    if (!target) return
    onReveal(target.id)
    setAnnouncement(`Suggestion ${next + 1} of ${count}`)
  }

  return (
    <RichTextToolbarGroup label="Suggestions">
      <RichTextButton
        label="Previous suggestion"
        disabled={!editor || total === 0}
        onClick={() => step(-1)}
      >
        <ChevronUpIcon aria-hidden="true" />
      </RichTextButton>
      <span className="text-muted-foreground min-w-12 px-1 text-center text-xs whitespace-nowrap tabular-nums">
        {total === 0
          ? "None open"
          : index === -1
            ? `${total} open`
            : `${index + 1} of ${total}`}
      </span>
      <span role="status" className="sr-only">
        {announcement}
      </span>
      <RichTextButton
        label="Next suggestion"
        disabled={!editor || total === 0}
        onClick={() => step(1)}
      >
        <ChevronDownIcon aria-hidden="true" />
      </RichTextButton>
    </RichTextToolbarGroup>
  )
}