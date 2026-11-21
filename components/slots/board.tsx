'use client'

import type { ComponentType } from 'react'
import type { BoardScreenProps } from './board-contract'

/** Shared card and column primitives for the public board contract. */
export { BoardCardView as BoardCard, BoardColumnView as BoardColumnFrame, BoardHiddenLaneView as BoardHiddenLane } from '@/components/blocks/kanban-board-1/components/board-parts'

/** Official builds supply this renderer. BoardPage and useIssueBoardSaves handle its actions. */
export const BoardScreen: ComponentType<BoardScreenProps> | null = null
