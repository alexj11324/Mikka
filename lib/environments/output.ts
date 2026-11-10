import { ENVIRONMENT_LIMITS } from './contract'

export type OutputStream = 'stdout' | 'stderr'
export type OutputSnapshot = { stdout: string; stderr: string; truncated: boolean }

const bytesOf = (value: string) => new TextEncoder().encode(value).length

/**
 * Bounded stdout/stderr for one run action. Raw text is kept per stream up to
 * a byte cap; masking happens on read, so a secret split across chunks is
 * still masked once the accumulated text is masked whole.
 */
export class BoundedOutput {
  private readonly chunks: Record<OutputStream, string[]> = { stdout: [], stderr: [] }
  private readonly bytes: Record<OutputStream, number> = { stdout: 0, stderr: 0 }
  truncated = false

  constructor(private readonly limit = ENVIRONMENT_LIMITS.logBytes) {}

  append(stream: OutputStream, text: string): void {
    if (!text) return
    const remaining = this.limit - this.bytes[stream]
    if (remaining <= 0) { this.truncated = true; return }
    const size = bytesOf(text)
    if (size <= remaining) {
      this.chunks[stream].push(text)
      this.bytes[stream] += size
      return
    }
    // Keep the longest prefix that fits without splitting a code point.
    let low = 0, high = text.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (bytesOf(text.slice(0, middle)) <= remaining) low = middle
      else high = middle - 1
    }
    if (low > 0) {
      this.chunks[stream].push(text.slice(0, low))
      this.bytes[stream] += bytesOf(text.slice(0, low))
    }
    this.truncated = true
  }

  snapshot(mask: (text: string) => string = text => text): OutputSnapshot {
    return {
      stdout: mask(this.chunks.stdout.join('')),
      stderr: mask(this.chunks.stderr.join('')),
      truncated: this.truncated,
    }
  }

  isEmpty(): boolean {
    return !this.chunks.stdout.length && !this.chunks.stderr.length
  }
}
