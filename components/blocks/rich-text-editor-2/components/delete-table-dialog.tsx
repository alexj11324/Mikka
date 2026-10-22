import { useState } from "react"
import { findParentNodeClosestToPos, type Editor } from "@tiptap/react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

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
function tableHeading(editor: Editor) {
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

  return heading || null
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
  const t = useTranslations('Editor.richText')
  const [name, setName] = useState(() => t('thisTable'))
  const [shownOpen, setShownOpen] = useState(open)

  // Named once on open, so the copy holds through the closing animation.
  if (open !== shownOpen) {
    setShownOpen(open)
    if (open && editor) setName(tableHeading(editor) ?? t('thisTable'))
  }

  function deleteTable() {
    editor?.chain().focus().deleteTable().run()
    onOpenChange(false)
    toast.success(t('tableDeleted'), {
      icon: TOAST_SUCCESS_ICON,
      description: name,
      duration: UNDO_TOAST_MS,
      action: {
        label: t('undoDeletion'),
        onClick: () => editor?.chain().focus().undo().run(),
      },
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* The bar that opened it hides with the table, so focus lands in the page. */}
      <AlertDialogContent size="sm" finalFocus={() => editor?.view.dom ?? true}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('deleteTableTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="text-foreground font-medium">{name}</span> {t('deleteTableDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={deleteTable}>
            {t('deleteTableAction')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}