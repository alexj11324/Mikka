'use client'

/**
 * 看板's columns and cards. The open-source UI draws the shared ones; a UI layer
 * may draw its own from the same props (docs/ui-overlay.md). The board, drag and
 * drop, menus and saves stay in KanbanBoard.
 */
export { BoardCardView as BoardCard, BoardColumnView as BoardColumnFrame, BoardHiddenLaneView as BoardHiddenLane } from '@/components/blocks/kanban-board-1/components/board-parts'
