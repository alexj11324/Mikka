// 4e2 item 4: run checkpoints carry the agent's uncommitted diff. The wire patch is gzipped
// `git diff --binary` (runCheckpointSchema); it is gunzipped, masked line-wise (a secret never spans
// lines in a diff hunk, so hunk headers stay valid) and gzipped again. A plain patch is masked as is.
// Non-UTF-8 content is left as is (git binary hunks are base85, not plaintext). A gzip stream that
// cannot be inflated within the cap is refused rather than stored unmasked.
import { gunzipSync, gzipSync } from 'node:zlib'
import { maskDeep, type Masker, identityMasker } from './mask'

/** Inflated-size cap for masking a checkpoint (the wire cap is on the gzipped bytes). */
export const CHECKPOINT_MASK_MAX_INFLATED = 64 * 1024 * 1024
export class CheckpointUnmaskable extends Error { constructor() { super('checkpoint_unmaskable') } }

function maskText(bytes: Buffer, mask: Masker): Buffer {
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? Buffer.from(mask(text), 'utf8') : bytes
}

export function maskCheckpoint<F>(input: { patch: Buffer; files: F }, mask: Masker): { patch: Buffer; files: F } {
  if (mask === identityMasker) return input
  let patch: Buffer
  if (input.patch.length >= 2 && input.patch[0] === 0x1f && input.patch[1] === 0x8b) {
    let inflated: Buffer
    try { inflated = gunzipSync(input.patch, { maxOutputLength: CHECKPOINT_MASK_MAX_INFLATED }) } catch { throw new CheckpointUnmaskable() }
    const masked = maskText(inflated, mask)
    patch = masked === inflated ? input.patch : gzipSync(masked)
  } else patch = maskText(input.patch, mask)
  return { patch, files: maskDeep(input.files, mask) }
}
