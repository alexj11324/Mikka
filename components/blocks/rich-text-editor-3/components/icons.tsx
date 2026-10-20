import { CircleCheckIcon, AlertCircleIcon } from "lucide-react";

// The Toaster's glyph carries no state colour, so typed toasts pass these.
export const TOAST_SUCCESS_ICON = (
  <CircleCheckIcon aria-hidden="true" className="text-success size-4" />
)

export const TOAST_ERROR_ICON = (
  <AlertCircleIcon aria-hidden="true" className="text-destructive size-4" />
)