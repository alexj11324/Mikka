// One selection rule for the production worker, model catalogue and release
// gate. The template records which CLI bytes were present before installation.
// Runtime reads only that small receipt; CI checksums the full binaries.
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, isAbsolute } from 'node:path'
import { z } from 'zod'
import { findOnPath } from './path-search'

export const HOSTED_CLI_MANIFEST = '/opt/mikka/worker/.mikka-original-cli.json'
export const LEGACY_HOSTED_CLI_MANIFEST = '/opt/mikka/original-cli.json'
const MANIFEST_PATHS = [HOSTED_CLI_MANIFEST, LEGACY_HOSTED_CLI_MANIFEST] as const
type Harness = 'claude_code' | 'codex'
const binarySchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const manifestSchema = z.object({
  version: z.literal(1), kind: z.enum(['claude', 'codex', 'desktop', 'task']),
  original: z.object({ claude_code: binarySchema.nullable(), codex: binarySchema.nullable() }).strict(),
  added: z.object({ claude_code: binarySchema.optional(), codex: binarySchema.optional() }).strict(),
}).strict()
export type HostedCliManifest = z.infer<typeof manifestSchema>

export function readHostedCliManifest(paths: string | readonly string[] = MANIFEST_PATHS): HostedCliManifest | undefined {
  for (const path of typeof paths === 'string' ? [paths] : paths) {
    const value = readManifest(path)
    if (value) return value
  }
  return undefined
}

function readManifest(path: string): HostedCliManifest | undefined {
  let file
  try { file = lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw Error('hosted_cli_manifest_unavailable', { cause: error })
  }
  if (!file.isFile() || file.size > 8192) throw Error('hosted_cli_manifest_invalid')
  const value = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  if ((value.kind === 'claude' && !value.original.claude_code) || (value.kind === 'codex' && !value.original.codex))
    throw Error('hosted_official_cli_missing')
  for (const harness of ['claude_code', 'codex'] as const) {
    const original = value.original[harness], added = value.added[harness]
    if ((original && (!isAbsolute(original.path) || original.path.startsWith('/opt/mikka/'))) ||
      (added && (original || !added.path.startsWith('/opt/mikka/')))) throw Error('hosted_cli_manifest_invalid')
  }
  return value
}

function executable(path: string | undefined): string | undefined {
  if (!path) return undefined
  try {
    const resolved = realpathSync(path)
    accessSync(resolved, constants.X_OK)
    return lstatSync(resolved).isFile() ? resolved : undefined
  } catch { return undefined }
}

/** Explicit binaries are trusted daemon configuration, never task input. A
 * recorded template selection may not be replaced by an accidental override.
 * Legacy unrecorded images use only their original PATH binaries; the SDK's
 * bundled Claude never silently substitutes for a missing official CLI. */
export function hostedBinaries(passed?: Partial<Record<Harness, string>>, settings: { path?: string; manifestPath?: string | readonly string[] } = {}): Partial<Record<Harness, string>> {
  const manifest = readHostedCliManifest(settings.manifestPath)
  const path = settings.path ?? process.env.PATH ?? ''
  const selected: Partial<Record<Harness, string>> = {}
  for (const harness of ['claude_code', 'codex'] as const) {
    const recorded = manifest?.original[harness] ?? manifest?.added[harness]
    if (recorded) {
      const resolved = executable(recorded.path)
      if (resolved !== recorded.path || (passed?.[harness] && executable(passed[harness]) !== resolved))
        throw Error('hosted_recorded_cli_unavailable')
      selected[harness] = resolved
    } else if (manifest) {
      if (passed?.[harness]) throw Error('hosted_unrecorded_cli')
    } else if (passed?.[harness]) {
      const resolved = executable(passed[harness])
      if (resolved) selected[harness] = resolved
    } else {
      for (const directory of path.split(delimiter).filter(Boolean)) {
        const resolved = executable(findOnPath(harness === 'claude_code' ? 'claude' : 'codex', directory) ?? undefined)
        if (resolved && !resolved.startsWith('/opt/mikka/')) { selected[harness] = resolved; break }
      }
    }
  }
  return selected
}
