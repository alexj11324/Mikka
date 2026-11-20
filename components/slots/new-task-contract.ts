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

/** An Agent the task can run on (Claude Code or Codex). */
export type NewTaskAgent = { value: 'claude_code' | 'codex'; label: string }

/** A Project the task can go to, in the window's context line. */
export type NewTaskProject = { value: string; label: string }

/** A status the task can be created in (Mikka's own statuses), as a chip in the row of pills. */
export type NewTaskStatus = { value: string; label: string; /** Its mark, as Mikka draws it (`TaskStatusIcon`). */ mark: ReactNode }

/** A priority the task can be created in (Mikka's own priorities), as a chip beside the status. */
export type NewTaskPriority = { value: string; label: string; /** Its mark, as Mikka draws it (`PriorityIcon`). */ mark: ReactNode }

export type NewTaskProps = {
  intent?: 'create_only' | 'create_and_dispatch'
  /** 创建方式, when the person may switch between 只创建 and 创建并派发 (a page that can open the created task). */
  chooseIntent?: { onChange: (intent: 'create_only' | 'create_and_dispatch') => void; disabled: boolean }
  onClose: () => void
  /** The Project the task goes to: the project page's, else the person's default. The window reads it as a breadcrumb
   * before the title; absent, there is no context line (and the task is created without a Project). */
  project?: string | null
  /**
   * The Projects the person may switch to, when the page leaves the Project open (the personal default). Absent when
   * the page fixes it or there is nothing to choose; then the context line is the name alone. Never a precondition:
   * 创建任务 sends with whatever is chosen, including none.
   */
  projects?: { choices: NewTaskProject[]; value: string; onChange: (value: string) => void; disabled: boolean; noneLabel: string }
  /**
   * The status the task is created in. Absent when the request that creates it cannot carry one (a dispatched task is
   * created by its Bot's own command, which has no status field), so the window then draws no status chip.
   */
  status?: { choices: NewTaskStatus[]; value: string; onChange: (value: string) => void; disabled: boolean }
  /**
   * The priority the task is created in, drawn beside the status. Absent for the same reason a status is: a dispatched
   * task's own command (`create_and_dispatch`) carries no priority field, so the window then draws no priority chip.
   */
  priority?: { choices: NewTaskPriority[]; value: string; onChange: (value: string) => void; disabled: boolean }
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
  /** 交给哪个 Agent: required to create and dispatch; `value` is null until the person picks one (nothing is preselected). */
  agent: {
    choices: NewTaskAgent[]
    value: NewTaskAgent['value'] | null
    onChange: (value: NewTaskAgent['value']) => void
    disabled: boolean
  }
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
  /** 继续新建 (Capy's Create more): on, a created task clears the window and leaves it open for the next one. */
  more: { checked: boolean; onChange: (checked: boolean) => void }
  sending: boolean
  /** Whether 创建任务 can send now (a title or text, an Agent, a usable profile, files done, creation available). */
  canSubmit: boolean
  onSubmit: () => void
}
