// What 设置 › 用量's page receives (docs/ui-overlay.md). Reading, the month and
// grouping state and the CSV export stay in UsageSettings.
import type { WorkspaceUsage } from '@/lib/usage/read'

export type UsageView = 'bots' | 'members'

export type SettingsUsageProps = {
  /** `YYYY-MM`, UTC. */
  month: string
  /** The last six months, newest first, with labels in the user's locale. */
  months: Array<{ value: string; label: string }>
  onMonthChange: (month: string) => void
  /** Admins in a team workspace can group by member; otherwise always 'bots'. */
  view: UsageView
  onViewChange: (view: UsageView) => void
  /** The month's usage; undefined until the first read answers. Kept while another month loads. */
  usage: WorkspaceUsage | undefined
  /** The latest read failed: the words to show, already translated. */
  error: string | null
  /** The raw code behind `error`, for 详情 (`code (detail)`, never the upstream message). */
  errorCode: string | null
  /** 余额 in points, admins only; null when unknown or not shown. */
  balancePoints: number | null
  /** A personal workspace has one member: no 按成员 grouping. */
  personal: boolean
  /** Downloads the shown rows as CSV (admins). */
  onExport: () => void
}
