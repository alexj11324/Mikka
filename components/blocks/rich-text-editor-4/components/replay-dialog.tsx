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

import { PEER_TRACKS } from "./data"
import { firstName } from "./value-faces"

const PLAYERS = new Intl.ListFormat("en-US").format(
  [...new Set(PEER_TRACKS.map((track) => track.peer))].map(firstName)
)

interface ReplayDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

/** Replay rewinds every client to the seed, so your own edits need a confirm. */
export function ReplayDialog({
  open,
  onOpenChange,
  onConfirm,
}: ReplayDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Replay Session?</AlertDialogTitle>
          <AlertDialogDescription>
            Your edits and comments are discarded, and {PLAYERS} start the
            session over.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Replay
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}