import { useCallback } from "react"
import { TableKit } from "@tiptap/extension-table"
import { findParentNodeClosestToPos, type Editor } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { RichTextBubbleBar } from "./rich-text-bubble-bar"
import type { RichTextSlashItem } from "./rich-text-slash-menu"
import { useRichTextSelector } from "./rich-text-state"
import {
  RichTextButton,
  RichTextToggle,
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from "./rich-text-toolbar"
import { TableIcon, BetweenHorizontalEndIcon, BetweenVerticalEndIcon, PanelTopIcon, Trash2Icon, Rows3Icon, Columns3Icon } from "lucide-react"

/** Tables with draggable column edges; the header row comes from insertTable. */
export const RichTextTable = TableKit.configure({
  table: { resizable: true, cellMinWidth: 96 },
})

/** Table chrome from the host's table tokens. Tiptap ships no table CSS, and
 * its wrapper drops HTMLAttributes while resizable, hence descendant classes. */
export const RICH_TEXT_TABLE_PROSE = cn(
  // The top gap holds the table bar, so it never covers the line above.
  "[&_.tiptap_.tableWrapper]:mt-10 [&_.tiptap_.tableWrapper]:mb-6 [&_.tiptap_.tableWrapper]:overflow-x-auto",
  "[&_.tiptap_table]:w-full [&_.tiptap_table]:table-fixed [&_.tiptap_table]:border-collapse [&_.tiptap_table]:text-sm",
  "[&_.tiptap_:is(td,th)]:border-border [&_.tiptap_:is(td,th)]:relative [&_.tiptap_:is(td,th)]:border [&_.tiptap_:is(td,th)]:px-3 [&_.tiptap_:is(td,th)]:py-2 [&_.tiptap_:is(td,th)]:text-start [&_.tiptap_:is(td,th)]:align-top",
  "[&_.tiptap_th]:bg-muted [&_.tiptap_th]:text-muted-foreground [&_.tiptap_th]:font-medium",
  "[&_.tiptap_.selectedCell]:after:bg-primary/10 [&_.tiptap_.selectedCell]:after:pointer-events-none [&_.tiptap_.selectedCell]:after:absolute [&_.tiptap_.selectedCell]:after:inset-0 [&_.tiptap_.selectedCell]:after:content-['']",
  "[&_.tiptap_.column-resize-handle]:bg-primary [&_.tiptap_.column-resize-handle]:pointer-events-none [&_.tiptap_.column-resize-handle]:absolute [&_.tiptap_.column-resize-handle]:inset-y-0 [&_.tiptap_.column-resize-handle]:-end-px [&_.tiptap_.column-resize-handle]:z-10 [&_.tiptap_.column-resize-handle]:w-0.5",
  "[&_.tiptap.resize-cursor]:cursor-col-resize"
)

export const RICH_TEXT_TABLE_SLASH_ITEM: RichTextSlashItem = {
  id: "table",
  group: "Advanced",
  title: "Table",
  hint: "Rows and columns with a header",
  keywords: ["grid", "rows", "columns", "spreadsheet"],
  icon: (
    <TableIcon aria-hidden="true" />
  ),
  // Cells accept blocks, so a table would nest inside a table.
  can: (editor) => !editor.isActive("table"),
  run: (editor, range) =>
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run(),
}

interface TableSnapshot {
  headerRow: boolean
  canDeleteRow: boolean
  canDeleteColumn: boolean
}

const IDLE_TABLE: TableSnapshot = {
  headerRow: false,
  canDeleteRow: false,
  canDeleteColumn: false,
}

function findTable(editor: Editor) {
  return findParentNodeClosestToPos(
    editor.state.selection.$from,
    (node) => node.type.name === "table"
  )
}

// The engine reports the last row and column as deletable, then refuses.
function readTable(editor: Editor | null): TableSnapshot {
  const table = editor ? findTable(editor) : undefined
  const firstRow = table?.node.firstChild

  if (!table || !firstRow) return IDLE_TABLE

  let columns = 0
  firstRow.forEach((cell) => {
    columns += Number(cell.attrs.colspan ?? 1)
  })

  return {
    headerRow: firstRow.firstChild?.type.name === "tableHeader",
    canDeleteRow: table.node.childCount > 1,
    canDeleteColumn: columns > 1,
  }
}

const TABLE_BUBBLE_KEY = "richTextTableBubble"

const TABLE_BUBBLE_OPTIONS = { placement: "top-start", offset: 4 } as const

function showInTable({
  editor,
  element,
}: {
  editor: Editor
  element: HTMLElement
}) {
  return (
    editor.isEditable &&
    editor.isActive("table") &&
    (editor.view.hasFocus() || element.contains(document.activeElement))
  )
}

interface RichTextTableBubbleProps {
  editor: Editor
  /** Deleting the whole table is the host's call: confirm it first. */
  onDeleteTable: () => void
}

/** Row, column and header controls above the table holding the caret. */
export function RichTextTableBubble({
  editor,
  onDeleteTable,
}: RichTextTableBubbleProps) {
  const table = useRichTextSelector(editor, readTable)

  // Anchors to the whole table, so the bar holds still while the caret moves.
  const getTableRect = useCallback(() => {
    const found = findTable(editor)
    const dom = found ? editor.view.nodeDOM(found.pos) : null

    if (!(dom instanceof HTMLElement)) return null

    return {
      getBoundingClientRect: () => dom.getBoundingClientRect(),
      getClientRects: () => [dom.getBoundingClientRect()],
      contextElement: dom,
    }
  }, [editor])

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={TABLE_BUBBLE_KEY}
      shouldShow={showInTable}
      getReferencedVirtualElement={getTableRect}
      options={TABLE_BUBBLE_OPTIONS}
      className="z-50"
    >
      <RichTextBubbleBar
        editor={editor}
        pluginKey={TABLE_BUBBLE_KEY}
        label="Table"
      >
        <RichTextToolbarGroup label="Insert">
          <RichTextButton
            label="Add row below"
            onClick={() => editor.chain().focus().addRowAfter().run()}
          >
            <BetweenHorizontalEndIcon aria-hidden="true" />
          </RichTextButton>
          <RichTextButton
            label="Add column right"
            onClick={() => editor.chain().focus().addColumnAfter().run()}
          >
            <BetweenVerticalEndIcon aria-hidden="true" />
          </RichTextButton>
        </RichTextToolbarGroup>
        <RichTextToolbarSeparator />
        <RichTextToggle
          label="Header row"
          pressed={table.headerRow}
          onToggle={() => editor.chain().focus().toggleHeaderRow().run()}
        >
          <PanelTopIcon aria-hidden="true" />
        </RichTextToggle>
        <RichTextToolbarSeparator />
        <DropdownMenu>
          <Tooltip>
            {/* The span carries the tooltip, so the trigger keeps its own props. */}
            <TooltipTrigger render={<span className="flex shrink-0" />}>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete"
                    data-toolbar-item=""
                  />
                }
              >
                <Trash2Icon aria-hidden="true" />
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="start"
            className="w-auto"
            finalFocus={() => editor.view.dom}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Delete</DropdownMenuLabel>
              <DropdownMenuItem
                disabled={!table.canDeleteRow}
                onClick={() => editor.chain().focus().deleteRow().run()}
              >
                <Rows3Icon aria-hidden="true" />
                Delete Row
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!table.canDeleteColumn}
                onClick={() => editor.chain().focus().deleteColumn().run()}
              >
                <Columns3Icon aria-hidden="true" />
                Delete Column
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDeleteTable}>
              <Trash2Icon aria-hidden="true" />
              Delete Table
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </RichTextBubbleBar>
    </BubbleMenu>
  )
}