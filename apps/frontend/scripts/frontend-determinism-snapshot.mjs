import * as fs from 'node:fs/promises'
import { basename, join } from 'node:path'
import { mock } from 'node:test'

let sequence = 0
mock.module('node:fs/promises', { namedExports: { ...fs, rm: async (path, options) => {
  if (typeof path === 'string' && basename(path).startsWith('mikka-build-output-')) {
    const target = join(process.env.PROBE_CASE_DIRECTORY, 'snapshot-' + sequence++)
    await fs.mkdir(process.env.PROBE_CASE_DIRECTORY, { recursive: true })
    await fs.cp(path, target, { recursive: true })
    console.log(JSON.stringify({ event: 'snapshot-before-normal-cleanup', directory: target }))
  }
  return fs.rm(path, options)
} } })
