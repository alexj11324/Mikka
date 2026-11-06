import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostedBinaries } from './hosted-binaries'
import { probeHarnessModels } from './model-probe'
import type { HarnessInfo } from '@mikka/protocol'

/** Ask the actual template CLIs without an owner, credential or task. */
export async function probeHostedModels(): Promise<HarnessInfo[]> {
  const scratchDir = mkdtempSync(join(tmpdir(), 'mikka-template-models-'))
  try {
    return (await Promise.all(Object.entries(hostedBinaries()).map(async ([harness, binary]) => {
      if (!binary || (harness !== 'codex' && harness !== 'claude_code')) return []
      const report = await probeHarnessModels(harness, binary, { scratchDir })
      return report ? [{ harness, installed: true, version: null, ...report } as HarnessInfo] : []
    }))).flat()
  } finally { rmSync(scratchDir, { recursive: true, force: true }) }
}
