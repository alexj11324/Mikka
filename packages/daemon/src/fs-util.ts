import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs"
import { dirname } from "node:path"

/**
 * Write a temp file, fsync it, then rename over the target, so a crash or
 * power loss leaves either the old or the new file, never half of one
 * (`runs.json`, `device.json`, acks).
 */
export function writeFileAtomic(file: string, data: string, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = openSync(tmp, "w", mode)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

export function writeJsonAtomic(file: string, value: unknown) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** Parsed JSON, or `undefined` when the file is missing or unreadable. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
