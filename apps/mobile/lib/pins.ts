/**
 * 对话's pinned row: the bots the person pinned, the Coordinator first among
 * them; every other row stays in the list. The star marks a pin, the same for
 * every bot (Alex): the Coordinator has it while pinned and loses it when not.
 */
export function splitPinned<Row extends { kind: string; bot?: { pinned?: boolean; coordinator?: boolean } }>(rows: readonly Row[]) {
  const isPinned = (row: Row) => row.kind === 'bot' && Boolean(row.bot?.pinned)
  const pinned = rows.filter(isPinned).sort((a, b) => Number(Boolean(b.bot?.coordinator)) - Number(Boolean(a.bot?.coordinator)))
  return { pinned, rest: rows.filter(row => !isPinned(row)) }
}

/** A bot's chat from the bot list (lib/navigate chatPath); the Coordinator's row opens it as `coordinator`, the workspace's own. */
export const botPath = (bot: { id: string; coordinator?: boolean }) => `/bots/${bot.coordinator ? 'coordinator' : bot.id}` as const
