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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TOAST_ERROR_ICON } from "./icons"
import { CheckIcon, MoreHorizontalIcon, LinkIcon, CodeIcon, RotateCcwIcon } from "lucide-react"

type CopyTarget = "link" | "html"

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

const COPIED_ICON = (
  <CheckIcon aria-hidden="true" />
)

interface SpecActionsProps {
  editor: Editor | null
  onReplay: () => void
}

/** Share and session actions; a copy confirms in place, only a failure toasts. */
export function SpecActions({ editor, onReplay }: SpecActionsProps) {
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const copiedTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])

  async function copy(target: CopyTarget) {
    const value =
      target === "link" ? window.location.href : (editor?.getHTML() ?? "")
    if (!value || !(await writeClipboard(value))) return

    setCopied(target)
    window.clearTimeout(copiedTimer.current)
    // Frozen demo guard: ?demo=frozen pins the demo, so no timer starts.
    if (document.documentElement.dataset.demo === "frozen") return
    copiedTimer.current = window.setTimeout(() => setCopied(null), COPIED_MS)
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
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Share</DropdownMenuLabel>
          {/* Stays open, so the swap to Copied is seen where it was clicked. */}
          <DropdownMenuItem closeOnClick={false} onClick={() => copy("link")}>
            {copied === "link" ? (
              COPIED_ICON
            ) : (
              <LinkIcon aria-hidden="true" />
            )}
            {copied === "link" ? "Copied" : "Copy Link"}
          </DropdownMenuItem>
          <DropdownMenuItem
            closeOnClick={false}
            disabled={!editor}
            onClick={() => copy("html")}
          >
            {copied === "html" ? (
              COPIED_ICON
            ) : (
              <CodeIcon aria-hidden="true" />
            )}
            {copied === "html" ? "Copied" : "Copy HTML"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Demo</DropdownMenuLabel>
          <DropdownMenuItem onClick={onReplay}>
            <RotateCcwIcon aria-hidden="true" />
            Replay Session
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}