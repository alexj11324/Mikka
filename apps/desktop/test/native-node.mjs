import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { tsImport } from 'tsx/esm/api'

const { loginShell, quote } = await tsImport('../src/main/ssh-install.ts', import.meta.url)
const execute = promisify(execFile)
const marker = 'MIKKA_NATIVE_NODE='
const probe = 'process.stdout.write(' + JSON.stringify(marker) + '+JSON.stringify({version:process.versions.node,executable:process.execPath})+"\\n")'

/** Only closed metadata escapes this probe. Shell startup output and executable
 * paths stay in memory; they may contain the runner's private environment. */
export async function inspectLoginNode(shell, env, expected) {
  const unknown = { status: 'command-failed', version: null, executable: 'unknown' }
  let stdout
  try {
    ;({ stdout } = await execute(shell.command, shell.args('node -e ' + quote(probe)), {
      env, timeout: 10_000, maxBuffer: 65_536,
    }))
  } catch { return unknown }
  try {
    const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(marker))
    if (lines.length !== 1) return { ...unknown, status: 'invalid-output' }
    const value = JSON.parse(lines[0].slice(marker.length))
    if (!value || typeof value.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.version)
      || typeof value.executable !== 'string' || !isAbsolute(value.executable)) {
      return { ...unknown, status: 'invalid-output' }
    }
    const resolved = await realpath(value.executable)
    return { status: 'ok', version: value.version, executable: resolved === expected ? 'selected' : 'other' }
  } catch { return { ...unknown, status: 'invalid-output' } }
}

/** This changes the disposable runner's login configuration, not the product's
 * shell selection or Node >=24 prerequisite. The caller owns this profile. */
export async function alignLoginNode({ home, env, shell, executable = process.execPath }) {
  const report = { version: 1, passed: false, stage: 'selected-node', selectedVersion: process.versions.node,
    before: null, after: null, profileUpdated: false, failure: null }
  try {
    const selected = await realpath(executable)
    if (Number(process.versions.node.split('.')[0]) !== 24) {
      report.failure = 'NATIVE_NODE_SELECTED_VERSION_REQUIRED'
      return report
    }
    report.stage = 'before-login'
    report.before = await inspectLoginNode(shell, env, selected)
    report.stage = 'login-profile'
    // The fixed official macos-15 ARM image uses bash and an existing regular
    // .bash_profile which sources .bashrc, then Homebrew's Node22 shellenv.
    // Append only the selected setup-node bin after that existing initialization.
    const profile = await open(join(home, '.bash_profile'), constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW)
    try {
      const info = await profile.stat()
      if (!info.isFile() || info.size > 65_536) {
        report.failure = 'NATIVE_NODE_PROFILE_INVALID'
        return report
      }
      const previous = await profile.readFile('utf8')
      const line = 'export PATH=' + quote(dirname(executable)) + ':"$PATH"'
      if (!previous.split(/\r?\n/).includes(line)) {
        await profile.writeFile('\n# Mikka native CI: keep the selected Node after Homebrew login initialization.\n' + line + '\n')
        report.profileUpdated = true
      }
    } finally { await profile.close() }
    report.stage = 'after-login'
    report.after = await inspectLoginNode(shell, env, selected)
    if (report.after.status !== 'ok' || report.after.executable !== 'selected' || report.after.version !== process.versions.node) {
      report.failure = 'NATIVE_NODE_LOGIN_MISMATCH'
      return report
    }
    report.stage = 'complete'
    report.passed = true
    return report
  } catch {
    report.failure = report.stage === 'login-profile' ? 'NATIVE_NODE_PROFILE_FAILED' : 'NATIVE_NODE_SETUP_FAILED'
    return report
  }
}

async function main() {
  let report = { version: 1, passed: false, stage: 'environment', selectedVersion: process.versions.node, selectedSource: 'unverified', failure: 'NATIVE_NODE_CI_ENVIRONMENT_REQUIRED' }
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.env.GITHUB_ACTIONS !== 'true'
      || process.env.RUNNER_OS !== 'macOS' || !isAbsolute(process.env.RUNNER_TOOL_CACHE ?? '')) return report
    const shell = loginShell(process.env, process.platform)
    if (basename(shell.command) !== 'bash') return { ...report, failure: 'NATIVE_NODE_LOGIN_SHELL_UNSUPPORTED' }
    const selected = await realpath(process.execPath)
    const cached = await realpath(join(process.env.RUNNER_TOOL_CACHE, 'node', process.versions.node, 'arm64', 'bin', 'node'))
    if (selected !== cached) return { ...report, failure: 'NATIVE_NODE_TOOLCACHE_MISMATCH' }
    report = { ...await alignLoginNode({ home: homedir(), env: process.env, shell }), selectedSource: 'toolcache' }
    return report
  } catch { return { ...report, failure: 'NATIVE_NODE_CI_SETUP_FAILED' } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await main()
  process.stdout.write(JSON.stringify(report) + '\n')
  process.exitCode = report.passed ? 0 : 1
}
