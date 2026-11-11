// What the new-task slot receives (docs/ui-overlay.md). 新建任务 (NewTaskDialog, components/coordinator/new-task-dialog.tsx)
// keeps its data, state and sending; a layer draws the window from these props while it is open.
import type { ReactNode } from 'react'

/** A place the task can run: 按工作区设置, Mikka Cloud, or one of the person's computers. */
export type NewTaskMachine = {
  value: string
  label: string
  /** The machine's icon with its state dot, as Mikka draws it. */
  icon: ReactNode
  usable: boolean
  /** Why it cannot take the task now, or its state (离线, 填入 E2B Key…). */
  note?: string
  group: 'default' | 'cloud' | 'own'
}

/** Who gets the request (交给): the Coordinator (`id` null) or a Bot. */
export type NewTaskBot = { id: string | null; name: string; avatar: ReactNode }

/** An Agent 配置 the task can use; `auto` is 自动. */
/** An Agent 配置 choice; `icon` is its ProfileMark as Mikka draws it, absent for 自动. */
export type NewTaskProfile = { value: string; label: string; detail?: string; disabled?: boolean; icon?: ReactNode }

export type NewTaskProps = {
  intent?: 'create_only' | 'create_and_dispatch'
  onClose: () => void
  /** The project page the request came from. */
  project?: string | null
  /** 标题 the person wrote (optional; empty, the Bot writes one). */
  title: string
  onTitle: (title: string) => void
  /** Longest title. */
  titleMax: number
  /** The request, without the attached files' text (they show as cards). */
  text: string
  onText: (text: string) => void
  maxLength: number
  /** The attached files' cards, as Mikka draws them; null when there are none. */
  files: ReactNode
  /** Files picked, dropped or pasted. */
  onAttach: (files: File[]) => void
  /** The file picker's accept list. */
  accept: string
  machines: NewTaskMachine[]
  /** The picked machine's `value` (`auto` for 按工作区设置). */
  machine: string
  onMachine: (value: string) => void
  /** Empty when there is no Bot to hand to besides the Coordinator; then there is no 交给 choice. */
  bots: NewTaskBot[]
  bot: string | null
  onBot: (id: string | null) => void
  profile: {
    choices: NewTaskProfile[]
    value: string
    /** The picked profile's name, 自动 when none. */
    label: string
    /** The picked profile's mark; absent for 自动. */
    icon?: ReactNode
    onChange: (value: string) => void
    /** 管理: opens Settings in a new tab; absent without a workspace. */
    onManage?: () => void
    disabled: boolean
  }
  /** Profile checks, 未开启任务创建 and Coordinator unavailable, as Mikka draws them; null when there are none. */
  notices: ReactNode
  sending: boolean
  /** Whether 创建任务 can send now (a title or text, a usable profile, files done, creation available). */
  canSubmit: boolean
  onSubmit: () => void
}
