import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { tsImport } from 'tsx/esm/api'
import { alignLoginNode, inspectLoginNode } from './native-node.mjs'

const { loginShell, quote } = await tsImport('../src/main/ssh-install.ts', import.meta.url)

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mikka-native-node-'))
  const competing = join(home, 'default-bin')
  const wrapper = join(home, 'login-shell')
  const profile = join(home, '.bash_profile')
  await mkdir(competing)
  // A real shell startup overrides the inherited PATH, as the ARM runner's
  // Homebrew initialization does. This deliberately failing fixture command
  // is not presented as an actual Node22 runtime.
  await writeFile(join(competing, 'node'), '#!/bin/sh\nexit 47\n')
  await chmod(join(competing, 'node'), 0o700)
  await writeFile(profile, 'export PATH=' + quote(competing) + ':"$PATH"\n')
  await writeFile(wrapper, '#!/bin/bash\n[ "$1" = "-lc" ] || exit 97\n. "$HOME/.bash_profile"\neval "$2"\n')
  await chmod(wrapper, 0o700)
  const env = { ...process.env, HOME: home, SHELL: wrapper, PATH: dirname(process.execPath) + ':' + process.env.PATH }
  return { home, profile, env, shell: loginShell(env, 'darwin'), cleanup: () => rm(home, { recursive: true, force: true }) }
}

test('real shell startup reselects the actual Node24 binary after startup shadows inherited PATH', { timeout: 20_000 }, async () => {
  const item = await fixture()
  try {
    const report = await alignLoginNode(item)
    assert.equal(report.passed, true)
    assert.deepEqual(report.before, { status: 'command-failed', version: null, executable: 'unknown' })
    assert.deepEqual(report.after, { status: 'ok', version: process.versions.node, executable: 'selected' })
    assert.equal(report.profileUpdated, true)
    assert.equal(JSON.stringify(report).includes(item.home), false)
    assert.equal(JSON.stringify(report).includes(process.execPath), false)
    const first = await readFile(item.profile, 'utf8')
    const again = await alignLoginNode(item)
    assert.equal(again.passed, true)
    assert.equal(again.profileUpdated, false)
    assert.equal(await readFile(item.profile, 'utf8'), first)
  } finally { await item.cleanup() }
})

test('profile export preserves a selected binary directory containing shell metacharacters', { timeout: 20_000 }, async () => {
  const item = await fixture()
  try {
    const directory = join(item.home, "selected node's $UNSET_NODE_PATH")
    await mkdir(directory)
    const executable = join(directory, 'node')
    await symlink(process.execPath, executable)
    const report = await alignLoginNode({ ...item, executable })
    assert.equal(report.passed, true)
    assert.equal(report.after.executable, 'selected')
    assert.equal(report.after.version, process.versions.node)
  } finally { await item.cleanup() }
})

test('a symlink login profile is refused without modifying its target', { timeout: 20_000 }, async () => {
  const item = await fixture()
  try {
    const target = join(item.home, 'other-profile')
    const previous = await readFile(item.profile, 'utf8')
    await writeFile(target, previous)
    await rm(item.profile)
    await symlink(target, item.profile)
    const report = await alignLoginNode(item)
    assert.equal(report.passed, false)
    assert.equal(report.stage, 'login-profile')
    assert.equal(report.failure, 'NATIVE_NODE_PROFILE_FAILED')
    assert.equal(await readFile(target, 'utf8'), previous)
  } finally { await item.cleanup() }
})

test('probe diagnostics never return startup output or malformed values', { timeout: 20_000 }, async () => {
  const item = await fixture()
  try {
    const command = join(item.home, 'default-bin', 'node')
    await writeFile(command, '#!/bin/sh\nprintf \'%s\\n\' \'private-startup-canary\' \'MIKKA_NATIVE_NODE={"version":["24.0.0"],"executable":"/private-path-canary"}\'\n')
    const result = await inspectLoginNode(item.shell, item.env, process.execPath)
    assert.deepEqual(result, { status: 'invalid-output', version: null, executable: 'unknown' })
    assert.equal(JSON.stringify(result).includes('canary'), false)
  } finally { await item.cleanup() }
})
