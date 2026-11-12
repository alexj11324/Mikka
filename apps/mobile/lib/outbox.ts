import type { ChatDelivery } from '../../../lib/hooks/chat-delivery-state'

export interface OutgoingImage { uri: string; dataUrl: string }
export type Outgoing = ChatDelivery<{
  id: string
  key: string
  submissionId: string
  at: number
  sourceCardId?: string
  botId: string | null
  chatKey: string
  context: number
  text: string
  images: OutgoingImage[]
}>

export const outgoingKey = (newId: () => string = () => globalThis.crypto.randomUUID()) => newId()

export function personalMessage(id: string, text: string, images: readonly OutgoingImage[], scope: Pick<Outgoing, 'botId' | 'chatKey' | 'context' | 'sourceCardId'>): Outgoing {
  return { ...scope, id, key: id, submissionId: id, at: Date.now(), text, images: images.map(image => ({ ...image })), phase: 'sending' }
}

export function unsettled(list: readonly Outgoing[], text: string, images: readonly OutgoingImage[], chatKey: string, context: number, sourceCardId?: string): Outgoing | undefined {
  return list.find(item => item.phase !== 'accepted' && item.chatKey === chatKey && item.context === context && item.sourceCardId === sourceCardId && item.text === text
    && item.images.length === images.length && item.images.every((image, index) => image.dataUrl === images[index].dataUrl))
}

export function canAnswerCard(list: readonly Outgoing[], cardId: string) {
  return !list.some(item => item.sourceCardId === cardId && item.phase !== 'failed')
}

export const submissionBody = (item: Outgoing) => ({ text: item.text, botId: item.botId, submissionId: item.submissionId,
  ...(item.images.length ? { images: item.images.map(image => ({ dataUrl: image.dataUrl })) } : {}) })

/** A server refusal is known. A timeout, disconnect, unreadable receipt or 5xx may have committed. */
export function sendFailureState(error: unknown): 'failed' | 'unconfirmed' {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 ? 'failed' : 'unconfirmed'
}
