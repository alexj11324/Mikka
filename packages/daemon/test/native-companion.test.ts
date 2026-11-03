import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cleanupTempDirs, tempDir } from './helpers'

afterEach(cleanupTempDirs)

it('lets the hosted CLI discover its verified sibling executable in the filtered environment', async () => {
  const root = tempDir('native-companion-'), bin = join(root, 'pinned', 'bin')
  mkdirSync(bin, { recursive: true })
  const cli = join(bin, 'codex.mjs')
  writeFileSync(cli, '#!/usr/bin/env node\nimport {execFileSync} from "node:child_process";process.stdout.write(execFileSync("codex-code-mode-host",[],{encoding:"utf8"}));\n', { mode: 0o755 })
  writeFileSync(join(bin, 'codex-code-mode-host'), '#!/bin/sh\nprintf code-mode-host-ready\n', { mode: 0o755 })
  const child = spawn(process.execPath, [resolve(import.meta.dirname, '../src/agents/native-container.mjs')], {
    env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.resume()
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  child.stdin.end(JSON.stringify({ kind: 'codex', cli, node: process.execPath, brokerSocket: join(root, 'unused.sock'),
    cwd: root, args: [], env: { HOME: join(root, 'home') } })+'\n')
  expect(await exited).toBe(0)
  expect(stdout).toBe('code-mode-host-ready')
})
