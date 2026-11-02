/**
 * A change drawn at once and saved behind it (置顶, 通知 on a bot's page):
 * when the save fails the change is taken back. Returns whether it saved.
 */
export async function saveOptimistic(apply: () => void, save: () => Promise<unknown>, restore: () => void): Promise<boolean> {
  apply()
  try {
    await save()
    return true
  } catch {
    restore()
    return false
  }
}
