import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state"
import type { Editor } from "@tiptap/react"

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import {
  blockCommand,
  blockTargetAtPos,
  blockTextRange,
  canMoveBlock,
  deleteBlock,
  duplicateBlock,
  moveBlockDown,
  moveBlockUp,
  type BlockTarget,
} from "./rich-text-block-actions"
import { RICH_TEXT_OUTLINE_SLASH_ITEM } from "./rich-text-outline-node"
import { RICH_TEXT_BASIC_SLASH_ITEMS } from "./rich-text-slash-menu"
import { RICH_TEXT_TABLE_SLASH_ITEM } from "./rich-text-table"
import { useShortcutLabel } from "./rich-text-toolbar"
import { RefreshCwIcon, CopyIcon, ArrowUpIcon, ArrowDownIcon, Trash2Icon } from "lucide-react"

const TURN_INTO_IDS = new Set([
  "text",
  "heading-1",
  "heading-2",
  "heading-3",
  "bullet-list",
  "numbered-list",
  "task-list",
  "quote",
  "code-block",
])

const TURN_INTO = RICH_TEXT_BASIC_SLASH_ITEMS.filter((item) =>
  TURN_INTO_IDS.has(item.id)
)

const BLOCK_TITLES = new Map(
  [
    ...RICH_TEXT_BASIC_SLASH_ITEMS,
    RICH_TEXT_TABLE_SLASH_ITEM,
    RICH_TEXT_OUTLINE_SLASH_ITEM,
  ].map((item) => [item.id, item.title])
)

const LIST_KINDS: Record<string, string> = {
  bulletList: "bullet-list",
  orderedList: "numbered-list",
  taskList: "task-list",
}

// Quotes and list items are left first, so a pick converts just that block.
const WRAPPERS = new Set(["blockquote", "listItem", "taskItem"])

/** The slash menu id for a block, so the menu names it and Turn Into checks it. */
function blockKind({ node, parent }: BlockTarget) {
  switch (node.type.name) {
    case "paragraph":
      return "text"
    case "heading":
      return `heading-${String(node.attrs.level)}`
    case "codeBlock":
      return "code-block"
    case "blockquote":
      return "quote"
    case "horizontalRule":
      return "divider"
    case "table":
      return "table"
    case "richTextOutline":
      return "outline"
    default:
      return LIST_KINDS[parent.type.name] ?? node.type.name
  }
}

/** Lifts the caret's lines out of every list and quote around them. */
function unwrapBlock(editor: Editor) {
  for (let level = 0; level < 8; level++) {
    const item = ["taskItem", "listItem"].find((name) => editor.isActive(name))
    const lifted = item
      ? editor.commands.liftListItem(item)
      : editor.isActive("blockquote") && editor.commands.lift("blockquote")
    if (!lifted) return
  }
}

export interface BlockMenuState {
  pos: number
  kind: string
  canUp: boolean
  canDown: boolean
  /** Turn Into options the block accepts; empty for tables and atoms. */
  allowed: readonly string[]
}

/** Where the caret goes when the menu opens: the first text, else the block. */
export function blockMenuSelection(editor: Editor, target: BlockTarget) {
  const { doc } = editor.state
  const range = blockTextRange(target)
  if (range) return TextSelection.create(doc, range.from)
  if (target.node.isAtom) return NodeSelection.create(doc, target.pos)
  return Selection.findFrom(doc.resolve(target.pos + 1), 1, true)
}

/** Reads the menu for a block, once the caret sits inside it. */
export function readBlockMenu(
  editor: Editor,
  target: BlockTarget
): BlockMenuState {
  const kind = blockKind(target)
  let allowed: string[] = []
  // A quote or list item is unwrapped first, so every kind fits there.
  if (WRAPPERS.has(target.node.type.name)) {
    allowed = TURN_INTO.map((item) => item.id)
  } else if (TURN_INTO_IDS.has(kind)) {
    allowed = TURN_INTO.filter((item) => item.can(editor)).map(
      (item) => item.id
    )
  }
  return {
    pos: target.pos,
    kind,
    canUp: canMoveBlock(target, -1),
    canDown: canMoveBlock(target, 1),
    allowed,
  }
}

function MenuShortcut({ keys }: { keys: readonly string[] }) {
  return <DropdownMenuShortcut>{useShortcutLabel(keys)}</DropdownMenuShortcut>
}

interface RichTextBlockMenuItemsProps {
  editor: Editor
  menu: BlockMenuState
  /** Tables confirm before they go. */
  onDeleteTable: () => void
}

export function RichTextBlockMenuItems({
  editor,
  menu,
  onDeleteTable,
}: RichTextBlockMenuItemsProps) {
  function runOnBlock(action: Parameters<typeof blockCommand>[0]) {
    editor.chain().focus().command(blockCommand(action, menu.pos)).run()
  }

  function removeBlock() {
    // The table dialog reads the caret, which the menu already put inside.
    if (menu.kind === "table") onDeleteTable()
    else runOnBlock(deleteBlock)
  }

  function turnInto(id: string) {
    const item = TURN_INTO.find((option) => option.id === id)
    const target = blockTargetAtPos(editor.state.doc, menu.pos)
    const range = target ? blockTextRange(target) : null
    if (!item || !target || !range) return

    editor.chain().focus().setTextSelection(range).run()
    if (WRAPPERS.has(target.node.type.name)) unwrapBlock(editor)
    const { from } = editor.state.selection
    item.run(editor, { from, to: from })
    // A collapsed caret, so the format bar does not open over the block.
    editor.commands.setTextSelection(editor.state.selection.from)
  }

  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>
          {BLOCK_TITLES.get(menu.kind) ?? "Block"}
        </DropdownMenuLabel>
        {menu.allowed.length ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <RefreshCwIcon aria-hidden="true" />
              Turn Into
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={menu.kind}
                onValueChange={(value) => {
                  // Picking the current kind again would toggle it off.
                  if (typeof value === "string" && value !== menu.kind) {
                    turnInto(value)
                  }
                }}
              >
                {TURN_INTO.map((item) => (
                  <DropdownMenuRadioItem
                    key={item.id}
                    value={item.id}
                    disabled={
                      item.id !== menu.kind && !menu.allowed.includes(item.id)
                    }
                    closeOnClick
                  >
                    {item.icon}
                    {item.title}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuItem onClick={() => runOnBlock(duplicateBlock)}>
          <CopyIcon aria-hidden="true" />
          Duplicate
          <MenuShortcut keys={["mod", "D"]} />
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!menu.canUp}
          onClick={() => runOnBlock(moveBlockUp)}
        >
          <ArrowUpIcon aria-hidden="true" />
          Move Up
          <MenuShortcut keys={["mod", "shift", "↑"]} />
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!menu.canDown}
          onClick={() => runOnBlock(moveBlockDown)}
        >
          <ArrowDownIcon aria-hidden="true" />
          Move Down
          <MenuShortcut keys={["mod", "shift", "↓"]} />
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={removeBlock}>
        <Trash2Icon aria-hidden="true" />
        Delete
      </DropdownMenuItem>
    </>
  )
}