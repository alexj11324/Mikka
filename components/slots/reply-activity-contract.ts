// What the reply-activity slot receives (docs/ui-overlay.md): a reply's thinking and tool calls, already worked
// out by components/coordinator/reply-activity.tsx (labels, targets, failure reasons, summaries). A slot draws them.
import type { ReactNode } from 'react'

/** One tool call as the chat shows it. */
export type ActivityToolView = {
  key: string
  state: 'running' | 'done' | 'error'
  /** The action's icon. */
  icon: ReactNode
  /** What the call is, as the person reads it (「搜索网页」), or 「正在搜索网页」 while running. */
  title: string
  /** What it acted on (a task number, a page), if anything. */
  target?: string
  /** Why it failed, in words. */
  why?: string
  /** Readable lines about the call (who a dispatch went to, its thread, a quote); null when there are none. */
  details: ReactNode
  /** The raw input and output, folded under 「原始数据」 as the open-source chat draws them. */
  raw: ReactNode
  /** The raw input and output text, for a layer that draws its own. */
  input?: string
  output?: string
  /** False while running, or when there is nothing to open. */
  openable: boolean
  /**
   * The thread a dispatch started, when the chat shows it as a card under the reply (thread-card slot). A layer
   * that lets the card stand for the dispatch leaves this row out; the folded summary still counts it.
   */
  card?: string
}

export type ActivityThinkingProps = {
  running: boolean
  /** 「思考中」, 「思考了 N 秒」 or 「已思考」. */
  title: string
  seconds?: number
  /** The readable reasoning; undefined when the model returned none. */
  text?: string
  /** Opened for the first time: a stored reply loads its reasoning then. */
  onOpen?: () => void
}

export type ActivityGroupProps = {
  tools: ActivityToolView[]
  running: boolean
  /** The one line that says what the calls did. */
  summary: string
  failures: number
  /** 「N 个失败」. */
  failuresLabel: string
  leadIcon: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 全部展开 / 全部收起 for every group in the chat. */
  expandAll: ReactNode
}
