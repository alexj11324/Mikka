// The default new-bot slot (docs/ui-overlay.md): none. NewBotDialog draws its own dialog; a layer that draws
// 新建 Bot in its own window exports a component here.
import type { ComponentType } from 'react'
import type { NewBotProps } from './new-bot-contract'

export const NewBot: ComponentType<NewBotProps> | null = null
