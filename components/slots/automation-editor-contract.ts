// What the automation-editor slot receives (docs/ui-overlay.md): the editor's run-settings section — who runs it and
// where, with what, and where its runs are posted — as rows of controls. The draft, the reads behind each choice and
// every save stay in components/automations/automation-editor.tsx; a layer only draws the rows.
import type { ReactNode } from 'react'

export type AutomationSettingOption = { value: string; label: string; disabled?: boolean }
export type AutomationSettingControl =
  /** One choice from a list; `label` names it for assistive technology. */
  | { kind: 'select'; label: string; value: string; options: AutomationSettingOption[]; onChange: (value: string) => void; disabled?: boolean }
  /** On or off, taking effect in the draft at once. */
  | { kind: 'switch'; label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }
  /** An action that reveals a choice (Choose a channel). */
  | { kind: 'button'; label: string; onClick: () => void; disabled?: boolean }

export type AutomationSettingRow =
  /** A labelled row; its controls sit side by side at the end (Runs in: the mode and the Bot). */
  | { id: string; label: string; controls: AutomationSettingControl[] }
  /** Shared content under a row, drawn as given (the thread search of Runs in › An existing thread). */
  | { id: string; content: ReactNode }

export type AutomationSettingsProps = {
  /** The section's anchor and heading. */
  id: string
  title: string
  rows: AutomationSettingRow[]
  /** The reader cannot change this automation; every control is off. */
  disabled?: boolean
}
