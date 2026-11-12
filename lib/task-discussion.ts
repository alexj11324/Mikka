export interface ThreadMessage {
  id: string
  author: string
  authorUserId?: string
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
