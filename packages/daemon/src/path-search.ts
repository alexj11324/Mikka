// PATH lookups and additions for the sandbox tools.
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

/** The executable `command` resolves to on this PATH, as a shell would find it. */
export function findOnPath(command: string, path = process.env.PATH ?? ""): string | null {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not here; keep searching.
    }
  }
  return null
}

/** Append directories after the existing ones, so what the user's PATH resolves first still wins. */
export function appendToPath(directories: readonly string[]) {
  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  for (const directory of directories) {
    if (isAbsolute(directory) && !entries.includes(directory)) entries.push(directory)
  }
  process.env.PATH = entries.join(delimiter)
}
