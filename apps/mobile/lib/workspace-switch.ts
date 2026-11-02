/**
 * Switching workspace (设置 › 工作区): save the pick, read settings back, and
 * keep the old workspace when the server did not take it or could not be
 * reached. Returns null on success, else the line to show.
 */
export async function switchWorkspace(target: { id: string; name: string }, previous: string | null, deps: {
  save: (id: string) => Promise<void>
  current: () => Promise<string>
}): Promise<string | null> {
  try {
    await deps.save(target.id)
    if (await deps.current() === target.id) return null
    if (previous) await deps.save(previous)
    return `没切到 ${target.name}：你不在这个工作区`
  } catch {
    if (previous) await deps.save(previous).catch(() => undefined)
    return `没切到 ${target.name}：连不上 Mikka`
  }
}
