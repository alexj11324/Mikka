"use client"

import type { ComponentProps } from "react"
import { Avatar } from "@heroui/react/avatar"
import { cn } from "cn"

/**
 * HeroUI's Avatar, soft variant: a circle tinted with its colour. Only its
 * styles are imported (app/globals.css); the soft colour tokens live there too.
 * `color` takes HeroUI's names; a custom tint goes on the fallback's className.
 */
function SoftAvatar({ className, size = "md", ...props }: Omit<ComponentProps<typeof Avatar>, "variant">) {
  return <Avatar data-slot="soft-avatar" variant="soft" size={size} className={className} {...props} />
}

function SoftAvatarFallback({ className, ...props }: ComponentProps<typeof Avatar.Fallback>) {
  return <Avatar.Fallback data-slot="soft-avatar-fallback" className={cn("[&_svg]:size-1/2", className)} {...props} />
}

export { SoftAvatar, SoftAvatarFallback }
