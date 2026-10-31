import type { ReactNode } from 'react'
import { Host, Image } from '@expo/ui/swift-ui'
import type { ImageProps } from '@expo/ui/swift-ui'
import { colors } from '@/lib/theme'

/** An SF Symbol, drawn by SwiftUI. `web` is the web build's stand-in (Symbol.tsx). */
export function Symbol({ name, size = 20, color = colors.ink }: { name: NonNullable<ImageProps['systemName']>; size?: number; color?: string; web?: ReactNode }) {
  return <Host matchContents><Image systemName={name} size={size} color={color} /></Host>
}
