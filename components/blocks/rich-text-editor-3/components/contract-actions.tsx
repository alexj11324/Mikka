import { useEffect, useRef, useState } from "react"
import type { Editor } from "@tiptap/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TOAST_ERROR_ICON } from "./icons"
import { resolveChanges } from "./rich-text-changes"
import { CheckIcon, MoreHorizontalIcon, CodeIcon, FileTextIcon, CopyIcon } from "lucide-react"

type CopyFormat = "html" | "final" | "original"

// Long enough to read the swap, short enough to copy again.
const COPIED_MS = 1600

async function writeClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    toast.error("Copy failed", {
      icon: TOAST_ERROR_ICON,
      description: "The browser blocked clipboard access.",
    })
    return false
  }
}

/** The plain text as if every suggestion were accepted, or all rejected. */
function resolvedText(editor: Editor, resolution: "accept" | "reject") {
  const tr = editor.state.tr
  resolveChanges(tr, resolution, null)
  return tr.doc.textBetween(0, tr.doc.content.size, "\n\n")
}

const COPIED_ICON = (
  <CheckIcon aria-hidden="true" />
)

/** Export behind one menu; a copy confirms in place, only a failure toasts. */
export function ContractActions({ editor }: { editor: Editor | null }) {
  const [copied, setCopied] = useState<CopyFormat | null>(null)
  const copiedTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])

  async function copyAs(format: CopyFormat) {
    if (!editor) return

    const value =
      format === "html"
        ? editor.getHTML()
        : resolvedText(editor, format === "final" ? "accept" : "reject")

    if (await writeClipboard(value)) {
      setCopied(format)
      window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(null), COPIED_MS)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Document actions"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Export</DropdownMenuLabel>
          {/* Stays open, so the swap to Copied is seen where it was clicked. */}
          <DropdownMenuItem
            closeOnClick={false}
            disabled={!editor}
            onClick={() => copyAs("html")}
          >
            {copied === "html" ? (
              COPIED_ICON
            ) : (
              <CodeIcon aria-hidden="true" />
            )}
            {copied === "html" ? "Copied" : "Copy Redline HTML"}
          </DropdownMenuItem>
          <DropdownMenuItem
            closeOnClick={false}
            disabled={!editor}
            onClick={() => copyAs("final")}
          >
            {copied === "final" ? (
              COPIED_ICON
            ) : (
              <FileTextIcon aria-hidden="true" />
            )}
            {copied === "final" ? "Copied" : "Copy Final Text"}
          </DropdownMenuItem>
          <DropdownMenuItem
            closeOnClick={false}
            disabled={!editor}
            onClick={() => copyAs("original")}
          >
            {copied === "original" ? (
              COPIED_ICON
            ) : (
              <CopyIcon aria-hidden="true" />
            )}
            {copied === "original" ? "Copied" : "Copy Original Text"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}