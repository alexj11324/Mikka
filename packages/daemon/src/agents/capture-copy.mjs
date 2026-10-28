import { closeSync, constants, openSync, readSync, rmSync, writeSync } from "node:fs"

/** Copy exactly the checked descriptor, never reopening its pathname. */
export function copyCaptureFd(source, destination, size) {
  const out = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  let ok = false
  try {
    const buffer = Buffer.allocUnsafe(Math.min(size, 64 * 1024))
    let position = 0
    while (position < size) {
      const read = readSync(source, buffer, 0, Math.min(buffer.length, size - position), position)
      if (read === 0) throw new Error("Capture changed while copying.")
      let written = 0
      while (written < read) {
        const count = writeSync(out, buffer, written, read - written)
        if (count === 0) throw new Error("Capture copy failed.")
        written += count
      }
      position += read
    }
    ok = true
  } finally {
    closeSync(out)
    if (!ok) rmSync(destination, { force: true })
  }
}
