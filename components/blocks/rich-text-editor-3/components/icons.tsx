import { CircleCheck, CircleAlert } from "@/components/icons";

// The Toaster's glyph carries no state colour, so typed toasts pass these.
export const TOAST_SUCCESS_ICON = (
  <CircleCheck aria-hidden="true" className="text-success-foreground size-4" />
)

export const TOAST_ERROR_ICON = (
  <CircleAlert aria-hidden="true" className="text-destructive-foreground size-4" />
)