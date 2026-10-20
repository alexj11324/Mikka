import { useEffect, useRef } from "react"
import { undoDepth } from "@tiptap/pm/history"
import type { Editor } from "@tiptap/react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

import { CONTRACT_META } from "./data"
import { TOAST_ERROR_ICON, TOAST_SUCCESS_ICON } from "./icons"
import type { SuggestionResolution } from "./rich-text-changes"

// Long enough to reach Undo after reading the count.
const UNDO_TOAST_MS = 8000

const COPY: Record<
  SuggestionResolution,
  {
    title: string
    action: string
    verb: [one: string, many: string]
    outcome: string
    toast: string
  }
> = {
  accept: {
    title: "Accept All Suggestions?",
    action: "Accept All",
    verb: ["becomes", "become"],
    outcome: "part of",
    toast: "accepted",
  },
  reject: {
    title: "Reject All Suggestions?",
    action: "Reject All",
    verb: ["is", "are"],
    outcome: "removed from",
    toast: "rejected",
  },
}

function plural(count: number) {
  return `${count} ${count === 1 ? "suggestion" : "suggestions"}`
}

interface ResolveAllDialogProps {
  editor: Editor | null
  open: boolean
  /** Kept after close, so the copy holds while the dialog animates out. */
  resolution: SuggestionResolution
  count: number
  onOpenChange: (open: boolean) => void
  /** From the page, focus returns to the text; a cancel in the Sheet stays there. */
  returnToText: boolean
  onResolved: () => void
}

/** One confirm for both bulk actions, then a typed toast with Undo. */
export function ResolveAllDialog({
  editor,
  open,
  resolution,
  count,
  onOpenChange,
  returnToText,
  onResolved,
}: ResolveAllDialogProps) {
  const copy = COPY[resolution]
  // Set when the action ran, so focus goes to the text even from the Sheet,
  // which the same action closes.
  const ranRef = useRef(false)

  useEffect(() => {
    if (open) ranRef.current = false
  }, [open])

  function resolveAll() {
    if (!editor) return

    // One transaction, so a single Undo brings every suggestion back.
    const done =
      resolution === "accept"
        ? editor.commands.acceptAllChanges()
        : editor.commands.rejectAllChanges()

    ranRef.current = done
    onOpenChange(false)
    onResolved()
    if (!done) return

    // Undo here reverts this action only; newer edits leave it to the toolbar.
    const depth = undoDepth(editor.state)
    toast.success(`${plural(count)} ${copy.toast}`, {
      icon: TOAST_SUCCESS_ICON,
      description: CONTRACT_META.title,
      duration: UNDO_TOAST_MS,
      action: {
        label: "Undo",
        onClick: () => {
          if (undoDepth(editor.state) === depth) {
            editor.chain().focus().undo().run()
            return
          }
          toast.error("Undo unavailable", {
            icon: TOAST_ERROR_ICON,
            description: "Newer edits came after it. Use Undo in the toolbar.",
          })
        },
      },
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        size="sm"
        finalFocus={() =>
          returnToText || ranRef.current ? (editor?.view.dom ?? true) : true
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="text-foreground font-medium">{plural(count)}</span>{" "}
            {copy.verb[count === 1 ? 0 : 1]} {copy.outcome}{" "}
            <span className="text-foreground font-medium">
              {CONTRACT_META.title}
            </span>
            .
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={resolution === "reject" ? "destructive" : "default"}
            onClick={resolveAll}
          >
            {copy.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}