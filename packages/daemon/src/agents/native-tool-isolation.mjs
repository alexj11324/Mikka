// The official Codex Linux sandbox is also the command executor for Claude's
// trusted MCP backend. Native model requests remain in the original CLI, direct
// to its provider. This module never accepts or forwards model credentials.
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

export const NATIVE_TOOL_PROFILE = 'mikka_tools_v1'
const RUNTIME_ROOTS = ['/opt/mikka/runtime/node', '/opt/mikka/runtime/harness-bin', '/opt/mikka/harness']
const SYSTEM_PATH = '/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:/usr/local/bin:/usr/bin:/bin'
const TRANSPORT_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
const AUTH_ENV = /^(?:ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|CHATGPT_|MIKKA_|GITHUB_|GH_|GIT_|AWS_|GOOGLE_|AZURE_|INFISICAL_|SSH_|LD_|DYLD_|NODE_OPTIONS$|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|PYTHONPATH$|PYTHONSTARTUP$|PERL5OPT$|RUBYOPT$)/i
const inside = (path, root) => path === root || path.startsWith(root + sep)

export function nativeRunToolConfig({ binary, worktree, runDir, readRoots = [], privateRoots = [], readOnly = false, taskEnv = {} }) {
  const root = join(absolute(runDir), 'native-tools')
  return { binary: absolute(binary), worktree: absolute(worktree), control: join(root, 'controller'),
    home: join(root, 'home'), temp: join(root, 'tmp'), readRoots: [...readRoots], privateRoots: [...privateRoots], readOnly, taskEnv: { ...taskEnv } }
}

function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || resolve(path) !== path || path === '/') throw Error('native_tool_path_invalid')
  return path
}

/** Host-provided task variables are the only additional tool environment.
 * Model/daemon authentication, loader injection and native HOME never survive. */
export function nativeToolEnvironment(config, inherited = process.env) {
  const env = { PATH: dirname(process.execPath) + ':' + SYSTEM_PATH, HOME: absolute(config.home), TMPDIR: absolute(config.temp), LANG: 'C.UTF-8' }
  for (const name of TRANSPORT_ENV) if (typeof inherited[name] === 'string') {
    if (/^(?:https?|all)_proxy$/i.test(name)) {
      try { const url = new URL(inherited[name]); if (url.username || url.password) continue } catch { continue }
    }
    env[name] = inherited[name]
  }
  for (const [name, value] of Object.entries(config.taskEnv ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || typeof value !== 'string' || value.includes('\0') || value.length > 65536) throw Error('native_tool_environment_invalid')
    if (!AUTH_ENV.test(name) && !['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME'].includes(name)) env[name] = value
  }
  return env
}

/** TOML inline tables, not JSON objects. All profile values are host-bound. */
export function nativeToolToml(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return '[' + value.map(nativeToolToml).join(',') + ']'
  return '{' + Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}=${nativeToolToml(child)}`).join(',') + '}'
}

/** Neither / nor the CLI/daemon HOME is a readable root. The native sandbox
 * supplies a new PID/user namespace and fresh procfs; it never inherits host
 * process access. Git administration remains read-only to untrusted tools. */
export function nativeToolFilesystem(config) {
  const worktree = absolute(config.worktree), home = absolute(config.home), temp = absolute(config.temp)
  const control = absolute(config.control), binary = absolute(config.binary)
  if ([control, binary, ...config.privateRoots ?? []].some(path => inside(absolute(path), worktree)) || inside(control, home) || inside(control, temp))
    throw Error('native_tool_private_root_overlap')
  const filesystem = { ':minimal': 'read', [worktree]: config.readOnly ? 'read' : 'write', [home]: 'write', [temp]: 'write', [binary]: 'read', [process.execPath]: 'read' }
  for (const root of [...RUNTIME_ROOTS, ...(config.readRoots ?? [])]) {
    absolute(root)
    if (existsSync(root)) {
      const real = realpathSync(root)
      if (real !== root || (config.privateRoots ?? []).some(privateRoot => inside(root, privateRoot) || inside(privateRoot, root))) throw Error('native_tool_read_root_invalid')
      if (!(root in filesystem)) filesystem[root] = 'read'
    }
  }
  // :minimal includes /etc for system libraries. Auth/configuration there is
  // never part of the shared coding environment, even on a self-hosted image.
  for (const root of ['/etc/codex', '/etc/mikka', '/etc/shadow', '/etc/gshadow', control]) filesystem[root] = 'deny'
  // These files would influence a later trusted native controller or host Git.
  // Codex also protects .git/.codex metadata inside its writable roots.
  for (const name of ['.git', '.codex', '.claude', '.agents']) filesystem[join(worktree, name)] = 'read'
  return filesystem
}

export function nativeToolConfigArgs(config, inherited = process.env) {
  const filesystem = nativeToolFilesystem(config)
  const env = nativeToolEnvironment(config, inherited)
  const values = {
    default_permissions: NATIVE_TOOL_PROFILE,
    [`permissions.${NATIVE_TOOL_PROFILE}.filesystem`]: filesystem,
    [`permissions.${NATIVE_TOOL_PROFILE}.network.enabled`]: true,
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.ignore_default_excludes': false,
    'shell_environment_policy.set': env,
    'features.use_legacy_landlock': false,
    'features.use_linux_sandbox_bwrap': true,
    'features.hooks': false,
    'features.codex_hooks': false,
    'features.plugin_hooks': false,
    'features.multi_agent': false,
    'features.shell_snapshot': false,
    'features.js_repl': false,
    'features.code_mode': false,
    'features.code_mode_only': false,
    'features.plugins': false,
    'features.request_permissions': false,
    'features.request_permissions_tool': false,
    'apps._default.enabled': false,
    web_search: 'disabled',
    // The repository is data. It cannot add an unsandboxed MCP process,
    // provider override, hook or plugin while the CLI holds authentication.
    [`projects.${JSON.stringify(config.worktree)}.trust_level`]: 'untrusted',
    [`projects.${JSON.stringify(config.temp)}.trust_level`]: 'untrusted',
  }
  for (const root of config.readRoots ?? []) values[`projects.${JSON.stringify(root)}.trust_level`] = 'untrusted'
  return Object.entries(values).flatMap(([key, value]) => ['-c', `${key}=${nativeToolToml(value)}`])
}

export function prepareNativeToolDirectories(config) {
  if (process.platform !== 'linux') throw Error('native_tool_isolation_unavailable')
  nativeToolFilesystem(config)
  for (const path of [config.control, config.home, config.temp]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
      throw Error('native_tool_directory_unsafe')
  }
  const root = realpathSync(config.worktree)
  if (root !== config.worktree || !lstatSync(root).isDirectory()) throw Error('native_tool_worktree_unsafe')
}

/** The controller and all of its descendants share a private PID namespace.
 * Killing its bwrap parent tears down that namespace, including double-forked
 * children that created a new process group. The inner official sandbox still
 * supplies the tool filesystem and clean environment boundary.
 *
 * A native controller must also be unable to load repository MCP/config code.
 * Codex project trust alone is not a security boundary: 0.163 can start a repo
 * MCP while reloading thread configuration. Mask those directories in this
 * process's mount namespace without modifying repository files or host policy.
 */
export function nativeControllerCommand(config, argv, { hideProjectConfig = false } = {}) {
  prepareNativeToolDirectories(config)
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw Error('native_tool_command_invalid')
  const bundled = join(dirname(dirname(realpathSync(config.binary))), 'codex-resources', 'bwrap')
  const bwrap = [bundled, '/usr/bin/bwrap', '/bin/bwrap'].find(candidate => {
    try { const stat = lstatSync(candidate); return stat.isFile() && (stat.mode & 0o022) === 0 && (stat.mode & 0o111) !== 0 }
    catch { return false }
  })
  if (!bwrap) throw Error('native_tool_isolation_unavailable')
  const args = ['--unshare-user', '--unshare-pid', '--new-session', '--die-with-parent', '--as-pid-1',
    '--bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--cap-drop', 'ALL']
  if (hideProjectConfig) {
    const empty = join(config.control, 'repository-config-disabled')
    mkdirSync(empty, { recursive: true, mode: 0o700 })
    const masked = new Set()
    for (const root of [config.worktree, config.temp, ...(config.readRoots ?? [])]) {
      let directory = absolute(root)
      while (true) {
        const local = join(directory, '.codex')
        if (!masked.has(local) && existsSync(local)) {
          // Never traverse a repository-controlled config symlink while
          // constructing a trusted controller's mount layout.
          const stat = lstatSync(local)
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('native_tool_project_config_unsafe')
          args.push('--ro-bind', empty, local); masked.add(local)
        }
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
      }
    }
  }
  return [bwrap, ...args, '--', ...argv]
}

/** Actual command execution. No model/API/authorization round trip. The child
 * has only stdio; the official sandbox owns its mount, PID and syscall boundary. */
export async function runNativeToolCommand(config, command, { signal, timeoutMs = 120000, maxOutputBytes = 2 * 1024 * 1024, inherited = process.env, onStdout } = {}) {
  signal?.throwIfAborted()
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > 65536 ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) throw Error('native_tool_command_invalid')
  prepareNativeToolDirectories(config)
  const args = ['sandbox', '--permission-profile', NATIVE_TOOL_PROFILE, ...nativeToolConfigArgs(config, inherited), '--',
    '/bin/sh', '-c', 'unset CODEX_HOME; cd -- "$1" && exec /bin/sh -c "$2"', 'mikka-isolated-tool', config.worktree, command]
  const env = { ...nativeToolEnvironment(config, inherited), CODEX_HOME: config.control }
  // Keep the outer bwrap in the CLI's owned process group. Its PID-1 child
  // owns all nested namespaces, so Stop cannot leave a detached tool alive.
  const [binary, ...isolatedArgs] = nativeControllerCommand(config, [config.binary, ...args], { hideProjectConfig: true })
  const child = spawn(binary, isolatedArgs, { cwd: config.temp, env, detached: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', bytes = 0, timedOut = false, overflow = false
  const stop = () => {
    try { child.kill('SIGKILL') } catch { /* Already exited. */ }
  }
  const collect = name => data => {
    bytes += data.length
    if (bytes > maxOutputBytes) { overflow = true; stop(); return }
    if (name === 'stdout') { const chunk = data.toString('utf8'); stdout += chunk; onStdout?.(chunk) }
    else stderr += data.toString('utf8')
  }
  child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'))
  const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, exitSignal) => resolve({ exitCode, signal: exitSignal }))
    })
    return { ...result, stdout, stderr, timedOut, overflow }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', stop); stop()
  }
}

const probes = new Map()
/** Not an executable/version check. An actual attack reads a synthetic native
 * HOME and a separate process environment, and writes the allowed worktree.
 * A failed namespace or ignored profile never advertises the capability. */
export function probeNativeToolIsolation(binary) {
  if (process.platform !== 'linux' || typeof binary !== 'string' || !isAbsolute(binary)) return Promise.resolve(false)
  let signature
  try { const s = lstatSync(binary); signature = JSON.stringify([binary, s.dev, s.ino, s.size, s.mtimeMs]); if (!s.isFile() || (s.mode & 0o022) !== 0) return Promise.resolve(false) }
  catch { return Promise.resolve(false) }
  if (probes.has(signature)) return probes.get(signature)
  const probing = (async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'mikka-native-isolation-'))
    const secret = randomBytes(32).toString('hex'), worktree = join(root, 'work'), control = join(root, 'controller'), home = join(root, 'tool-home'), temp = join(root, 'tool-tmp')
    const hidden = join(root, 'native-auth')
    mkdirSync(worktree, { mode: 0o700 }); mkdirSync(hidden, { mode: 0o700 })
    const credential = join(hidden, 'auth.json'); writeFileSync(credential, secret, { mode: 0o600 })
    const keeper = spawn('/bin/sh', ['-c', 'exec sleep 20'], { env: { PATH: '/usr/bin:/bin', MIKKA_MODEL_API_KEY: secret }, stdio: 'ignore' })
    try {
      const quote = value => `'${value.replaceAll("'", `'"'"'`)}'`
      const attempt = [credential, `/proc/${keeper.pid}/environ`, `/proc/${keeper.pid}/root${credential}`]
        .map(path => `cat ${quote(path)} 2>/dev/null || true`).join('\n')
      const result = await runNativeToolCommand({ binary, worktree, control, home, temp, privateRoots: [hidden], readOnly: false },
        `${attempt}\nenv\nprintf allowed > proof.txt\nprintf '\\nisolation-probe-complete\\n'`,
        { timeoutMs: 8000, inherited: { ...process.env, MIKKA_MODEL_API_KEY: secret, ANTHROPIC_API_KEY: secret } })
      return result.exitCode === 0 && !result.timedOut && !result.overflow && result.stdout.includes('isolation-probe-complete') &&
        !result.stdout.includes(secret) && !result.stderr.includes(secret) && readFileSync(join(worktree, 'proof.txt'), 'utf8') === 'allowed'
    } catch { return false }
    finally { keeper.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }) }
  })()
  probes.set(signature, probing)
  return probing
}
