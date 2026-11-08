/** Only Git's built-in CRLF clean conversion is implemented here. Repository
 * filters, encodings and ident expansion are never executed by a read request. */
export type CleanAttributes = Record<'text' | 'eol' | 'crlf' | 'filter' | 'working-tree-encoding' | 'ident', string>
export type CleanAction = 'raw' | 'text' | 'auto' | 'unsupported'

export function cleanAction(attributes: CleanAttributes, autoCRLF: string): CleanAction {
  if (![undefined, 'unspecified', 'unset'].includes(attributes.filter)
    || ![undefined, 'unspecified', 'unset'].includes(attributes['working-tree-encoding'])
    || attributes.ident === 'set') return 'unsupported'
  const legacy = attributes.crlf === 'unset' ? 'raw' : ['set', 'input'].includes(attributes.crlf) ? 'text' : attributes.crlf === 'auto' ? 'auto' : undefined
  let action: CleanAction | undefined = attributes.text === 'unset' ? 'raw'
    : ['set', 'input'].includes(attributes.text) ? 'text' : attributes.text === 'auto' ? 'auto' : legacy
  if (action === 'raw') return action
  if (['lf', 'crlf'].includes(attributes.eol)) action ??= 'text'
  return action ?? (['true', 'input'].includes(autoCRLF) ? 'auto' : 'raw')
}

/** Git's text heuristic is byte-based, independent of whether the UI can
 * display UTF-8. Keep CR across chunk boundaries and ignore a trailing DOS EOF. */
export class GitTextStats {
  crlf = 0
  private loneCR = 0
  private printable = 0
  private controls = 0
  private nul = false
  private pendingCR = false
  private last = -1
  push(bytes: Uint8Array) {
    for (const byte of bytes) {
      this.last = byte
      if (this.pendingCR) {
        this.pendingCR = false
        if (byte === 10) { this.crlf++; continue }
        this.loneCR++
      }
      if (byte === 13) { this.pendingCR = true; continue }
      if (byte === 10) continue
      if (byte === 0) this.nul = true
      if (byte === 127 || (byte < 32 && ![8, 9, 12, 27].includes(byte))) this.controls++
      else this.printable++
    }
  }
  get binary() {
    return this.nul || this.loneCR > 0 || this.pendingCR
      || this.controls - Number(this.last === 26) > Math.floor(this.printable / 128)
  }
}

export class CRLFCleaner {
  private pendingCR = false
  push(bytes: Uint8Array): Buffer {
    const output = Buffer.allocUnsafe(bytes.length + 1)
    let length = 0
    for (const byte of bytes) {
      if (this.pendingCR) { if (byte !== 10) output[length++] = 13; this.pendingCR = false }
      if (byte === 13) this.pendingCR = true
      else output[length++] = byte
    }
    return output.subarray(0, length)
  }
  finish(): Buffer { const tail = this.pendingCR ? Buffer.from([13]) : Buffer.alloc(0); this.pendingCR = false; return tail }
}
