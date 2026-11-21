'use client'

import { createContext, useContext } from 'react'
import type { ThreadScreenProps } from '@/components/slots/thread-contract'

/**
 * The right-hand tabs a page hands its chat when the frame owns the panel (FRAME_OWNS_PANEL):
 * the Overview and the browser travel to the conversation's work area instead of a column beside it.
 *
 * It lives in its own module because both the page and the thread panel read it, and
 * `conversation-panels.tsx` imports the panel (which would make a cycle). A provider is the only
 * thing a page needs to give a conversation its work area; no conversation outside the provider —
 * a thread in the right column, a task's own pane — sees one.
 */
export const ConversationPanels = createContext<ThreadScreenProps['panels'] | undefined>(undefined)

export const useConversationPanels = () => useContext(ConversationPanels)
