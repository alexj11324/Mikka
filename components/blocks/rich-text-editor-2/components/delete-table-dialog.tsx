import { useState } from "react"
import { findParentNodeClosestToPos, type Editor } from "@tiptap/react"
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

import { TOAST_SUCCESS_ICON } from "./icons"

// Long enough to reach Undo from the keyboard (WCAG 2.2.1).
const UNDO_TOAST_MS = 8000

/** Tables have no title, so the heading above one names it. */
function tableName(editor: Editor) {
  const table = findParentNodeClosestToPos(
    editor.state.selection.$from,
    (node) => node.type.name === "table"
  )
  let heading = ""

  editor.state.doc.descendants((node, pos) => {
    if (!table || pos >= table.pos) return false
    if (node.type.name === "heading" && node.textContent.trim()) {
      heading = node.textContent.trim()
    }
    return node.type.name !== "heading"
  })

  return heading ? `${heading} table` : "This table"
}

interface DeleteTableDialogProps {
  editor: Editor | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Confirms before a whole table goes, then offers Undo. */
export function DeleteTableDialog({
  editor,
  open,
  onOpenChange,
}: DeleteTableDialogProps) {
  const [name, setName] = useState("This table")
  const [shownOpen, setShownOpen] = useState(open)

  // Named once on open, so the copy holds through the closing animation.
  if (open !== shownOpen) {
    setShownOpen(open)
    if (open && editor) setName(tableName(editor))
  }

  function deleteTable() {
    editor?.chain().focus().deleteTable().run()
    onOpenChange(false)
    toast.success("Table deleted", {
      icon: TOAST_SUCCESS_ICON,
      description: name,
      duration: UNDO_TOAST_MS,
      action: {
        label: "Undo",
        onClick: () => editor?.chain().focus().undo().run(),
      },
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* The bar that opened it hides with the table, so focus lands in the page. */}
      <AlertDialogContent size="sm" finalFocus={() => editor?.view.dom ?? true}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Table?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="text-foreground font-medium">{name}</span> and
            every row in it leave the page until you undo it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={deleteTable}>
            Delete Table
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}