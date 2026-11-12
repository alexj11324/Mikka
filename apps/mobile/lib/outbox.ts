/**
 * One immutable submission identity per unsettled message, for this screen's
 * lifetime. A lost response is unconfirmed, not evidence the server rejected it.
 * Retries (including the composer) reuse the original body and UUID.
 */
export interface Outgoing { sourceCardId?: string; key: string; submissionId: string; botId: string | null; chatKey: string; context: number; text: string; images: OutgoingImage[]; state: 'sending' | 'failed' | 'unconfirmed' }
export interface OutgoingImage { uri: string; dataUrl: string }

/** Native callers supply Expo's UUID implementation; Node/web use their crypto implementation. */
export const outgoingKey = (newId: () => string = () => globalThis.crypto.randomUUID()) => newId()

export const queued = (list: Outgoing[], key: string, text: string, images: OutgoingImage[] = [], scope: { sourceCardId?: string; botId?: string | null; chatKey?: string; context?: number } = {}): Outgoing[] => [...list, { ...(scope.sourceCardId ? { sourceCardId: scope.sourceCardId } : {}), key, submissionId: key, botId: scope.botId ?? null, chatKey: scope.chatKey ?? scope.botId ?? 'coordinator', context: scope.context ?? 0, text, images: images.map(image => ({ ...image })), state: 'sending' }]

export const marked = (list: Outgoing[], key: string, state: Outgoing['state']) => list.map(item => item.key === key ? { ...item, state } : item)

export const delivered = (list: Outgoing[], key: string) => list.filter(item => item.key !== key)

/** Whether any message is still on its way (the chat polls faster and shows the reply spinner). */
export const inFlight = (list: Outgoing[]) => list.some(item => item.state === 'sending')

export function unsettled(list: readonly Outgoing[], text: string, images: readonly OutgoingImage[], chatKey: string, context: number): Outgoing | undefined {
  return list.find(item => item.chatKey === chatKey && item.context === context && item.text === text
    && item.images.length === images.length && item.images.every((image, index) => image.dataUrl === images[index].dataUrl))
}

/** An unsettled card may retry its own immutable answer. Another card or a message still in flight keeps it locked. */
export function canAnswerCard(list: readonly Outgoing[], cardId: string) {
  return list.every(item => item.sourceCardId === cardId && item.state !== 'sending')
}

export const submissionBody = (item: Outgoing) => ({ text: item.text, botId: item.botId, submissionId: item.submissionId,
  ...(item.images.length ? { images: item.images.map(image => ({ dataUrl: image.dataUrl })) } : {}) })

/** A server refusal is known; a timeout, disconnect, unreadable receipt or 5xx may have committed. */
export function sendFailureState(error: unknown): 'failed' | 'unconfirmed' {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 ? 'failed' : 'unconfirmed'
}
