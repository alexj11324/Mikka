import { cn } from "cn"
import { LoaderCircle, type IconProps } from "@/components/icons"

function Spinner({ className, ...props }: IconProps) {
  return (
    // The reduce-motion guard lives here rather than at each call site: a
    // spinner that keeps turning under "reduce motion" is the one animation
    // that setting exists for. Callers still choose the colour.
    <LoaderCircle data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin motion-reduce:animate-none", className)} {...props} />
  )
}

export { Spinner }
