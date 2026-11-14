export type ThreadDeliveryMode = 'queue' | 'steer' | 'interrupt'
export type ThreadDeliveryView = {
  modes: ThreadDeliveryMode[]
  queued: { id: string; text: string; status: 'queued' | 'delivering' | 'sent' | 'cancelled' | 'failed'; failureCode: string | null; requestId: string }[]
}
