// 4e2 item 4: run checkpoints carry the agent's uncommitted diff. Text patches are masked line-wise
// (a secret never spans lines in a diff hunk, so hunk headers stay valid); binary/non-UTF-8 patches
// are left as is (masking bytes could not be applied and git binary hunks are base85, not plaintext).
import { maskDeep, type Masker, identityMasker } from './mask'

export function maskCheckpoint<F>(input: { patch: Buffer; files: F }, mask: Masker): { patch: Buffer; files: F } {
  if (mask === identityMasker) return input
  const text = input.patch.toString('utf8')
  const patch = Buffer.from(text, 'utf8').equals(input.patch) ? Buffer.from(mask(text), 'utf8') : input.patch
  return { patch, files: maskDeep(input.files, mask) }
}
