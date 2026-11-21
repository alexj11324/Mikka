// What the new-bot slot receives (docs/ui-overlay.md). 新建 Bot (NewBotDialog, components/nav/new-bot-dialog.tsx)
// keeps its state and createBot; a layer draws the window from these props while it is open.
import type { BotColor, BotShape } from '@/components/nav/bot-avatar'

/** One choice in a details row's menu. `group` starts a new section when it changes (a model's source). */
export type NewBotChoice = { value: string; label: string; detail?: string; group?: string }

/** A details row (模型, 仓库) beside the Bot, as Capy's new Captain has: its choices and the current one. */
export type NewBotDetail = {
  choices: NewBotChoice[]
  /** The current choice's `value`; null while the choices load. */
  value: string | null
  /** What the row shows: the current choice's label, or the loading text. */
  label: string
  onChange: (value: string) => void
  /** Still loading, or nothing to choose: the row shows its label without a menu. */
  disabled: boolean
}

export type NewBotProps = {
  onClose: () => void
  name: string
  onName: (name: string) => void
  /** The name's longest length. */
  maxLength: number
  color: BotColor
  shape: BotShape
  onColor: (color: BotColor) => void
  onShape: (shape: BotShape) => void
  /** The model the Bot's runs use (the model picker's menu); saved after the Bot is created. */
  model: NewBotDetail
  /** The repository the Bot works in; `NO_REPOSITORY` for none (the Bot works on Mikka Cloud). Superseded by `environment`: a pick binds the Environment that lists it. */
  repository: NewBotDetail
  /** The Environment the Bot works in (its repositories, setup and variables); the workspace default first. */
  environment?: NewBotDetail
  /** Machine: where the tasks it dispatches run (`cloud` Mikka Cloud, `cloudflare` the Cloudflare coding machine, or a device ID under 其他设备). */
  machine?: NewBotDetail
  /** The model's reasoning effort; `NO_EFFORT` is the model's default. */
  effort?: NewBotDetail
  /** Access: `private` or `shared` with the workspace. */
  access?: NewBotDetail
  saving: boolean
  /** Creates the Bot; errors show as a toast and the window stays. */
  onSubmit: () => void
}

/** The 仓库 row's value for no repository. */
export const NO_REPOSITORY = ''

/** The effort row's value for the model's default. */
export const NO_EFFORT = ''
