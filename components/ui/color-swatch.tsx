import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from 'cn'

// Border and radius live on the primitive. A settings card is already a frame,
// so the call site must not repeat both or the UI policy reads a nested frame.
const SHAPE = {
  plain: '',
  chip: 'size-4 rounded-sm border',
  tile: 'overflow-hidden rounded-md border',
} as const

/** Paints an arbitrary CSS color. Business settings cannot set `style`. */
export function ColorSwatch({
  color,
  shape = 'plain',
  className,
  children,
  ...props
}: {
  color?: string
  shape?: keyof typeof SHAPE
  className?: string
  children?: ReactNode
} & Pick<HTMLAttributes<HTMLSpanElement>, 'aria-hidden'>) {
  return <span className={cn(SHAPE[shape], className)} style={color ? { backgroundColor: color } : undefined} {...props}>{children}</span>
}
