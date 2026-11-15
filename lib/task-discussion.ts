export interface ThreadMessage {
  id: string
  author: string
  authorUserId?: string
  /** Identifies a specific comment when multiple Factory stages share the same thread. */
  replyToMessageId?: string
  body: string
  at: string
}

export interface ThreadRecord {
  id: string
  author: string
  createdAt: string
  resolved: boolean
  messages: ThreadMessage[]
}
