/**
 * The setup checklist on 新建任务 after the first-run guide (Capy's setup guide,
 * decision 2026-11-15-1900 rule 8). Pure, so the dialog and tests share it.
 */
export const SETUP_ITEMS = ['task', 'model', 'device', 'app', 'invite'] as const
export type SetupItem = (typeof SETUP_ITEMS)[number]
export type SetupChecklist = { dismissed: boolean; team: boolean; done: Partial<Record<SetupItem, true>> }

/** The items this person sees: 这台电脑 only in the desktop app, 邀请成员 only in a team workspace. */
export function visibleSetupItems(list: Pick<SetupChecklist, 'team'>, desktop: boolean): SetupItem[] {
  return SETUP_ITEMS.filter(item => (item !== 'device' || desktop) && (item !== 'invite' || list.team))
}

/** A checklist read as the server sent it; anything missing or malformed reads as nothing to show. */
export function readSetupChecklist(value: unknown): SetupChecklist | undefined {
  if (!value || typeof value !== 'object') return undefined
  const list = value as Partial<SetupChecklist>
  if (typeof list.dismissed !== 'boolean' || typeof list.team !== 'boolean' || !list.done || typeof list.done !== 'object') return undefined
  return { dismissed: list.dismissed, team: list.team, done: list.done }
}

/** Hidden once dismissed or once everything it shows is done; an absent or malformed read shows nothing. */
export function setupChecklistShown(value: unknown, desktop: boolean): boolean {
  const list = readSetupChecklist(value)
  if (!list || list.dismissed) return false
  return visibleSetupItems(list, desktop).some(item => !list.done[item])
}
