/**
 * Messages the person sent that the server has not taken yet (iMessage's
 * "Not Delivered", Slack's failed message). A message stays here, drawn as
 * its bubble, until its POST succeeds and the reloaded chat holds it; a
 * failed one stays with 「未发送 · 重试」 so its words are never lost.
 */
export interface Outgoing { key: string; text: string; images: OutgoingImage[]; state: 'sending' | 'failed' }
export interface OutgoingImage { uri: string; dataUrl: string }

let next = 0

export const outgoingKey = () => `out-${Date.now()}-${next++}`

export const queued = (list: Outgoing[], key: string, text: string, images: OutgoingImage[] = []): Outgoing[] => [...list, { key, text, images, state: 'sending' }]

export const marked = (list: Outgoing[], key: string, state: Outgoing['state']) => list.map(item => item.key === key ? { ...item, state } : item)

export const delivered = (list: Outgoing[], key: string) => list.filter(item => item.key !== key)

/** Whether any message is still on its way (the chat polls faster and shows the reply spinner). */
export const inFlight = (list: Outgoing[]) => list.some(item => item.state === 'sending')
