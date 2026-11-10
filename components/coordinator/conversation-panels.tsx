'use client'

import { createContext, useContext } from 'react'
import type { ThreadScreenProps } from '@/components/slots/thread-contract'

/**
 * The right-hand tabs a page hands its chat when the frame owns the panel (FRAME_OWNS_PANEL): the Overview
 * and the browser travel to the conversation's work area instead of a column beside it.
 */
export const ConversationPanels = createContext<ThreadScreenProps['panels'] | undefined>(undefined)
export const useConversationPanels = () => useContext(ConversationPanels)
