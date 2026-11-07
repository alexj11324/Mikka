import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostedBinaries, readHostedCliManifest, type HostedCliManifest } from './hosted-binaries'
import { probeHarnessModels } from './model-probe'
import type { HarnessInfo } from '@mikka/protocol'

type Binaries = Partial<Record<'codex' | 'claude_code', string>>
/** Trusted, anonymous in-memory state. No credentials or build-time TTL are
 * frozen into the snapshot. The daemon starts its six-hour TTL on handoff. */
export interface HostedModelProbe {
  binaries: Binaries
  fingerprint: string
  reports: HarnessInfo[]
  manifest?: HostedCliManifest
}

function selectionState(binaries: Binaries) {
  return { manifest: readHostedCliManifest(), binaries: Object.entries(binaries).map(([harness, path]) => {
    const info = statSync(path)
    return [harness, path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]
  }) }
}
const fingerprint = (binaries: Binaries) => JSON.stringify(selectionState(binaries))

/** Reuse only reports for the unchanged selection the runtime resolved. File
 * metadata catches ordinary CLI updates without hashing large binaries on the
 * task's startup path; release CI verifies their actual original bytes. */
export function reusableHostedModels(probe: HostedModelProbe | undefined, binaries: Binaries): HarnessInfo[] | undefined {
  if (!probe || fingerprint(binaries) !== probe.fingerprint) return undefined
  if (Object.entries(binaries).some(([harness, path]) => probe.binaries[harness as keyof Binaries] !== path ||
    !probe.reports.some(info => info.harness === harness && info.installed && info.models?.length))) return undefined
  return probe.reports
}

/** Preload all installed official CLIs in parallel, without an account or task.
 * Drain every child before returning or deleting any shared scratch directory. */
export async function probeHostedRuntimeModels(passed?: Binaries): Promise<HostedModelProbe> {
  const binaries = hostedBinaries(passed)
  const state = selectionState(binaries), before = JSON.stringify(state)
  const scratchDir = mkdtempSync(join(tmpdir(), 'mikka-template-models-'))
  try {
    const settled = await Promise.allSettled(Object.entries(binaries).map(async ([harness, binary]) => {
      const report = await probeHarnessModels(harness as 'codex' | 'claude_code', binary, { scratchDir })
      if (!report) throw Error('hosted_model_probe_unavailable')
      return { harness, installed: true, version: null, ...report } as HarnessInfo
    }))
    const reports: HarnessInfo[] = []
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason
      reports.push(result.value)
    }
    if (!reports.length || fingerprint(binaries) !== before) throw Error('hosted_model_probe_changed')
    return { binaries, fingerprint: before, reports, ...(state.manifest ? { manifest: state.manifest } : {}) }
  } finally { rmSync(scratchDir, { recursive: true, force: true }) }
}

/** Keep the build-time catalogue command's array-only output unchanged. */
export async function probeHostedModels(): Promise<HarnessInfo[]> {
  return (await probeHostedRuntimeModels()).reports
}
