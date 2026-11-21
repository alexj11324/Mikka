import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { BADGE_SIZE } from "@/components/ui/badge-size"
import { statusTones, type StatusTone } from '@/lib/status-appearance'

/** R-31's one secondary surface: `outline` and `secondary` are two names for it. */
const badgeBase =
  "group/badge inline-flex w-fit shrink-0 items-center justify-center overflow-hidden rounded-sm border border-transparent font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!"

const badgeVariants = cva(
  badgeBase,
  {
    variants: {
      size: { ...BADGE_SIZE },
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        // R-31, R-33: a tag is a 6px grey fill with no stroke, the same as statusTones.neutral.
        secondary:
          "bg-control text-foreground [a]:hover:bg-control-hover",
        destructive:
          "bg-destructive/10 text-destructive-foreground focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "bg-control text-muted-foreground [a]:hover:bg-control-hover [a]:hover:text-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      size: "md",
      variant: "default",
    },
  }
)

function Badge({
  className,
  size = "md",
  variant = "default",
  render,
  tone,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { tone?: StatusTone }) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ size, variant: tone ? 'outline' : variant }), tone && statusTones[tone], className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
