// The default group-chat slot (docs/ui-overlay.md): none. A group chat keeps the community layout in
// components/workspace/group-chat-view.tsx and its 详情 column; a layer that draws the whole chat exports a component here.
import type { ComponentType } from 'react'
import type { GroupChatProps } from './group-chat-contract'

export const GroupChat: ComponentType<GroupChatProps> | null = null
