type ProjectRecord = { id: string; name: string }

/** Only duplicate display names need a second line identifying the Project. */
export function taskProjectOptions(records: readonly ProjectRecord[], currentProjectId?: string | null) {
  const seen = new Set<string>()
  const ambiguous = new Set<string>()
  for (const { name } of records) {
    if (seen.has(name)) ambiguous.add(name)
    seen.add(name)
  }
  return records.map(({ id, name }) => ({
    id, label: name, description: ambiguous.has(name) ? id : undefined, checked: id === currentProjectId,
  }))
}
