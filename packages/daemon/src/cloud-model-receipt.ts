// A release reads the anonymous probe that made this snapshot ready. It never
// starts a second worker/CLI merely to recover the same catalogue.
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { harnessInfoSchema } from '@mikka/protocol'
import type { HostedModelProbe } from './cloud-model-probe'
import { writeFileAtomic } from './fs-util'

export const PRELOADED_MODEL_RECEIPT = 'preloaded-models.json'
export interface CloudWorkerIdentity { sourceCommit: string; workerSha: string }

/** Only the installed, root-owned release supplies identity. No environment,
 * device file, owner handoff or provider credential enters this receipt. */
export function installedCloudWorkerIdentity(): CloudWorkerIdentity {
  const marker = '/opt/mikka/worker-source-sha'
  const info = lstatSync(marker)
  const sourceCommit = /^\/opt\/mikka\/releases\/([a-f0-9]{40})\/source$/.exec(realpathSync('/opt/mikka/worker'))?.[1]
  const workerSha = readFileSync(marker, 'utf8').trim()
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o222) !== 0 ||
      !sourceCommit || !/^[a-f0-9]{40}$/.test(workerSha)) throw Error('cloud_model_receipt_identity_invalid')
  return { sourceCommit, workerSha }
}

const reportSchema = harnessInfoSchema.pick({
  harness: true, installed: true, version: true, models: true, modelSlots: true, defaultModelSlot: true,
}).strict()

/** Called after the probe has drained every CLI. Atomic rename exposes only
 * the complete, read-only catalogue; the caller announces PID-ready next. */
export function writePreloadedModelReceipt(directory: string, identity: CloudWorkerIdentity, probe: HostedModelProbe) {
  if (![identity.sourceCommit, identity.workerSha].every(value => /^[a-f0-9]{40}$/.test(value)))
    throw Error('cloud_model_receipt_identity_invalid')
  const manifest = probe.manifest
  if (!manifest) throw Error('cloud_model_receipt_manifest_missing')
  const binaries = Object.fromEntries((['claude_code', 'codex'] as const).flatMap(harness => {
    const binary = manifest.original[harness] ?? manifest.added[harness]
    return binary ? [[harness, binary.path]] : []
  }))
  const selected = Object.keys(binaries)
  if (!selected.length || selected.length !== Object.keys(probe.binaries).length ||
      selected.some(harness => binaries[harness] !== probe.binaries[harness as keyof typeof probe.binaries]))
    throw Error('cloud_model_receipt_selection_changed')
  const reports = probe.reports.map(info => reportSchema.parse(info))
  if (reports.length !== selected.length || new Set(reports.map(info => info.harness)).size !== selected.length ||
      reports.some(info => !selected.includes(info.harness) || !info.installed || info.version !== null ||
        !info.models?.length || info.modelSlots?.length !== info.models.length ||
        info.modelSlots.some((slot, index) => slot.slot !== info.models![index]) ||
        (info.defaultModelSlot && !info.models.includes(info.defaultModelSlot))))
    throw Error('cloud_model_receipt_reports_invalid')
  writeFileAtomic(join(directory, PRELOADED_MODEL_RECEIPT),
    JSON.stringify({ version: 1, sourceCommit: identity.sourceCommit, workerSha: identity.workerSha, manifest, binaries, reports }) + '\n', 0o444)
}
