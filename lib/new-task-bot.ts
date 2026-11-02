/**
 * The bots 新建任务 can hand a request to besides the Coordinator (usability review T4): every bot in the
 * person's list except the Coordinator's own row, which the dialog shows as its default.
 */
export function newTaskBotChoices<T extends { coordinator?: boolean }>(bots: readonly T[]): T[] {
  return bots.filter(bot => !bot.coordinator)
}
