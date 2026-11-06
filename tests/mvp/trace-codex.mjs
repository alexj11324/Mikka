// Synthetic Codex app-server peer for isolated HTTP trace acceptance. This is
// never an official CLI or a provider: version/model/usage are fixture values.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { callMcpTool } from '../../packages/daemon/test/fakes/mcp-call.mjs'
import { REPOSITORY } from './isolated-env.mjs'
import { recordPeerFailure } from './diagnostics.mjs'
import { MVP_NATIVE_ACCOUNT, MVP_NATIVE_TOKEN, MVP_SUBSCRIPTION_MODEL } from './subscription.mjs'

const execute = promisify(execFile)
const ghScript = fileURLToPath(new URL('../../scripts/dev-local/gh.mjs', import.meta.url))
const syntheticGitHubTokens = ['mvp-synthetic-installation-run', 'mikka-local-synthetic-user-token']

/** Match native gh's prepared login without reading a host login. Only the
 * fixture daemon's private generated config and two synthetic values qualify. */
export function traceGitHubEnvironment(directory, env = process.env) {
  let fd
  try {
    assert.ok(!env.GITHUB_TOKEN)
    if (env.GH_TOKEN) {
      assert.ok(syntheticGitHubTokens.includes(env.GH_TOKEN))
      return { ...env }
    }
    const root = resolve(directory), parent = join(root, 'adapters', 'github')
    const config = resolve(env.GH_CONFIG_DIR ?? '')
    assert.ok(dirname(config) === parent && /^github-[a-zA-Z0-9]{6}$/.test(basename(config)))
    const uid = process.getuid?.()
    assert.ok(uid !== undefined)
    for (const path of [root, join(root, 'adapters'), parent, config]) {
      const stat = lstatSync(path)
      assert.ok(stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0 && realpathSync(path) === path)
    }
    fd = openSync(join(config, 'hosts.yml'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.uid === uid && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= 4096)
    const bytes = Buffer.alloc(4097), count = readSync(fd, bytes, 0, bytes.length, null)
    assert.ok(count === stat.size && count <= 4096)
    const match = /^github\.com:\n    oauth_token: "(mvp-synthetic-installation-run|mikka-local-synthetic-user-token)"\n    git_protocol: https\n$/.exec(bytes.subarray(0, count).toString('utf8'))
    assert.ok(match)
    return { ...env, GH_TOKEN: match[1], GITHUB_TOKEN: '' }
  } catch (error) {
    throw new Error('SYNTHETIC_GITHUB_CONFIG_REQUIRED', { cause: error })
  } finally { if (fd !== undefined) closeSync(fd) }
}

/** Reuse dev:local's fixed loopback transport. Never select a machine's gh or
 * reuse its login; the real per-run credential helper wraps this executable. */
export function createTraceGitHubBinary(directory) {
  const bin = join(directory, 'fixture-bin')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  const binary = join(bin, 'gh')
  writeFileSync(binary, `#!${process.execPath}\nimport { fixtureGh } from ${JSON.stringify(ghScript)}\nimport { traceGitHubEnvironment } from ${JSON.stringify(import.meta.url)}\ntry { await fixtureGh(process.argv.slice(2), { env: traceGitHubEnvironment(${JSON.stringify(realpathSync(directory))}) }) }\ncatch { process.stderr.write('SYNTHETIC_GITHUB_FIXTURE_FAILED\\n'); process.exitCode = 1 }\n`, { mode: 0o700, flag: 'wx' })
  return binary
}

/** Local command/version checks only: no login, service request or DB write. */
export function checkTracePrerequisites(directory) {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('NODE_24_REQUIRED')
  const command = (file, args, code, additions = {}) => {
    try { return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', ...additions } }).trim() }
    catch { throw new Error(code) }
  }
  if (!command('git', ['--version'], 'MISSING_GIT_CLI').startsWith('git version ')) throw new Error('MISSING_GIT_CLI')
  const pinned = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).packageManager.split('@')[1].split('+')[0]
  if (command('corepack', ['pnpm', '--version'], 'MISSING_PINNED_PNPM') !== pinned) throw new Error('MISSING_PINNED_PNPM')
  const binary = createTraceGitHubBinary(directory)
  if (command(binary, ['--version'], 'MISSING_SYNTHETIC_GITHUB_CLI', { GH_TOKEN: 'mvp-synthetic-installation-run' }) !==
    'gh version local-fixture (synthetic GitHub transport)') throw new Error('MISSING_SYNTHETIC_GITHUB_CLI')
}

/** Same disposable path shape as the daemon's localGitOrigin contract. The
 * launcher validates its local-test environment before serializing this path;
 * native child processes receive no database URL or inherited Git credentials. */
function traceGitOrigin(value, temporaryRoot = realpathSync(tmpdir())) {
  const path = resolve(value ?? '')
  assert.ok(basename(path) === 'origin.git' && /^mvp-[a-f0-9-]{36}$/.test(basename(dirname(path)))
    && basename(dirname(dirname(path))).startsWith('mikka-mvp-origin-')
    && dirname(dirname(dirname(path))) === temporaryRoot
    && lstatSync(path).isDirectory() && realpathSync(path) === path, 'SYNTHETIC_GIT_ORIGIN_REQUIRED')
  return path
}

/** Only this known fixture URL can resolve, and Git itself refuses every
 * non-file protocol even if a local or inherited config tries to override it. */
export function traceGitCommand(barePath, cwd, args, temporaryRoot) {
  const origin = pathToFileURL(traceGitOrigin(barePath, temporaryRoot)).href
  return execute('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
    '-c', `url.${origin}.insteadOf=${REPOSITORY}`, ...args], { cwd, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: dirname(cwd), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
      GIT_AUTHOR_NAME: 'Synthetic trace fixture', GIT_AUTHOR_EMAIL: 'trace-fixture@mikka.invalid',
      GIT_COMMITTER_NAME: 'Synthetic trace fixture', GIT_COMMITTER_EMAIL: 'trace-fixture@mikka.invalid' },
  }).then(result => result.stdout.trim())
}

function deliveryContext(instructions) {
  if (typeof instructions !== 'string') return undefined
  // These lines are generated by RunContext, separate from the user prompt.
  const branch = /^- You own delivery to https:\/\/github\.com\/mikka-e2e\/core-loop\. Keep the current local branch\. Commit your tested work and push HEAD to (mikka\/[a-z0-9-]+-[1-9][0-9]*) using the HTTPS repository URL\. Never force-push\.$/m.exec(instructions)?.[1]
  const receipt = /^- Open or update the task pull request with gh, using head (mikka\/[a-z0-9-]+-[1-9][0-9]*)\. Its body must end with <!-- mikka-issue:([a-f0-9-]{36}) --> so Mikka can attach the result\.$/m.exec(instructions)
  if (!branch && !receipt) return undefined
  assert.equal(receipt?.[1], branch, 'SYNTHETIC_DELIVERY_CONTEXT_REQUIRED')
  return { branch, issueId: receipt[2] }
}

async function deliverTraceChange(config, delivery, stage) {
  stage('git_validate')
  assert.ok(delivery, 'SYNTHETIC_DELIVERY_CONTEXT_REQUIRED')
  // RunContext gives the CLI its own TMPDIR. Compare the origin with the
  // launcher's canonical root, captured before that child-only override.
  const git = args => traceGitCommand(config.barePath, process.cwd(), args, config.temporaryRoot)
  assert.equal(await git(['config', '--get', 'remote.origin.url']), REPOSITORY, 'SYNTHETIC_REPOSITORY_REQUIRED')
  assert.equal(await git(['ls-remote', '--get-url', REPOSITORY]), pathToFileURL(traceGitOrigin(config.barePath, config.temporaryRoot)).href, 'SYNTHETIC_GIT_REWRITE_REQUIRED')
  await git(['diff', '--check'])
  await git(['add', '--', 'MIKKA_MOCK.md'])
  stage('git_commit')
  await git(['commit', '-m', 'Exercise isolated trace delivery', '-m', `Mikka-Issue: ${delivery.issueId}`])
  stage('git_push')
  await git(['push', '--porcelain', REPOSITORY, `HEAD:refs/heads/${delivery.branch}`])
  const commit = await git(['rev-parse', 'HEAD'])
  assert.equal((await git(['ls-remote', '--exit-code', REPOSITORY, `refs/heads/${delivery.branch}`])).split(/\s+/)[0], commit, 'SYNTHETIC_PUSH_RECEIPT_REQUIRED')
  // PATH begins with the real run-local GitHub credential wrapper, which
  // reads the owner's synthetic login prepared by the authorized claim.
  // Host gh login and proxy/Node configuration never reach this subprocess.
  const gh = args => execute('gh', args, { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: process.env.NODE_ENV, NODE_OPTIONS: '',
      GH_CONFIG_DIR: join(config.directory, 'synthetic-gh-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' },
  }).then(result => result.stdout.trim())
  stage('pr_create')
  const pr = await gh(['pr', 'create', '--repo', 'mikka-e2e/core-loop', '--head', delivery.branch, '--base', 'trunk',
    '--title', 'Synthetic trace delivery', '--body', `Isolated synthetic fixture delivery.\n\n<!-- mikka-issue:${delivery.issueId} -->`])
  assert.match(pr, /^https:\/\/github\.com\/mikka-e2e\/core-loop\/pull\/[1-9][0-9]*$/, 'SYNTHETIC_PR_RECEIPT_REQUIRED')
  stage('pr_checks')
  await gh(['pr', 'checks', pr, '--watch'])
  assert.equal(await git(['status', '--porcelain']), '', 'SYNTHETIC_CLEAN_WORKTREE_REQUIRED')
}

/** Only the guarded fixture launcher selects this binary via the existing
 * DaemonOptions.harnessBinaries test seam. No production entry imports it. */
export function createTraceCodexBinary(directory, fixture, barePath) {
  const version = JSON.parse(readFileSync(new URL('../../packages/daemon/harness/pins.json', import.meta.url), 'utf8')).harnesses.codex.version
  const binary = join(directory, 'synthetic-codex.mjs')
  writeFileSync(binary, `#!/usr/bin/env node\nimport { runTraceCodex } from ${JSON.stringify(import.meta.url)}\nawait runTraceCodex(${JSON.stringify({ version, fixture: resolve(fixture), directory: resolve(directory), barePath: traceGitOrigin(barePath), temporaryRoot: realpathSync(tmpdir()) })})\n`, { mode: 0o700 })
  return binary
}

export async function runTraceCodex(config) {
  if (process.argv[2] === '--version') { process.stdout.write(`codex-cli ${config.version}\n`); return }
  assert.equal(process.argv[2], 'app-server', 'SYNTHETIC_CODEX_METHOD_REQUIRED')
  assert.ok(process.env.CODEX_HOME && !relative(config.directory, process.env.CODEX_HOME).startsWith('..'), 'SYNTHETIC_CODEX_HOME_REQUIRED')
  assert.ok(!process.env.OPENAI_API_KEY && !existsSync(join(process.env.CODEX_HOME, 'auth.json')), 'SYNTHETIC_CODEX_AUTH_FILE_REFUSED')
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  const mcp = { command: '', args: [], env: {} }
  for (let index = 3; index < process.argv.length; index++) {
    if (process.argv[index] !== '-c') continue
    const value = process.argv[++index], separator = value.indexOf('='), key = value.slice(0, separator)
    if (!key.startsWith('mcp_servers.mikka.')) continue
    const parsed = JSON.parse(value.slice(separator + 1))
    if (key === 'mcp_servers.mikka.command') mcp.command = parsed
    if (key === 'mcp_servers.mikka.args') mcp.args = parsed
    if (key.startsWith('mcp_servers.mikka.env.')) mcp.env[key.slice('mcp_servers.mikka.env.'.length)] = parsed
  }
  let initialized = false, authenticated = false, threadId, activeTurn, delivery, turn = 0
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    const { id, method, params } = request
    let operation
    try {
      if (method === 'initialize') {
        operation = 'initialize'
        initialized = true
        send({ id, result: { userAgent: `codex_cli_rs/${config.version} synthetic-trace-fixture` } })
      } else if (method === 'model/list') {
        operation = 'model_list'
        assert.ok(initialized)
        send({ id, result: { data: [{ id: MVP_SUBSCRIPTION_MODEL, model: MVP_SUBSCRIPTION_MODEL, displayName: 'Synthetic trace model', isDefault: true }], nextCursor: null } })
      } else if (method === 'account/login/start') {
        operation = 'oauth_login'
        assert.ok(initialized)
        assert.equal(params.type, 'chatgptAuthTokens')
        assert.equal(params.accessToken, MVP_NATIVE_TOKEN)
        assert.equal(params.chatgptAccountId, MVP_NATIVE_ACCOUNT)
        authenticated = true
        send({ id, result: { type: 'chatgptAuthTokens' } })
      } else if (method === 'thread/start') {
        operation = 'thread_start'
        assert.ok(authenticated)
        assert.equal(params.model, MVP_SUBSCRIPTION_MODEL)
        assert.equal(resolve(params.cwd), process.cwd())
        delivery = deliveryContext(params.developerInstructions)
        threadId = `synthetic-${randomUUID()}`
        send({ id, result: { thread: { id: threadId }, model: MVP_SUBSCRIPTION_MODEL } })
      } else if (method === 'turn/start') {
        operation = 'turn_start'
        assert.ok(authenticated && threadId && params.threadId === threadId)
        const turnId = `synthetic-turn-${++turn}`
        activeTurn = turnId
        send({ id, result: { turn: { id: turnId } } })
        send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', error: null } } })
        // Do not inspect or record the prompt. Replay only the host-selected
        // fixture; the real MCP submit must accept the run's current authority.
        const fixture = readFileSync(config.fixture, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const failed = fixture.find(part => part.exit?.outcome === 'failed')
        if (!failed) {
          for (const part of fixture) {
            assert.ok(!part.exec, 'SYNTHETIC_CODEX_SHELL_REFUSED')
            if (part.write) {
              operation = 'fixture_write'
              assert.equal(part.write.path, 'MIKKA_MOCK.md')
              writeFileSync(join(process.cwd(), part.write.path), part.write.content)
              send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'fileChange', id: 'synthetic-write', changes: [{ path: part.write.path, kind: { type: 'add' } }], status: 'completed' } } })
            }
            if (part.submit) {
              assert.ok(mcp.command && mcp.args.length, 'SYNTHETIC_CODEX_MCP_REQUIRED')
              await deliverTraceChange(config, delivery, value => { operation = value })
              operation = 'mcp_submit'
              const reply = await callMcpTool(mcp, 'submit', part.submit)
              assert.ok(reply.result && !reply.result.isError, 'SYNTHETIC_CODEX_SUBMIT_REFUSED')
            }
          }
          assert.ok(fixture.some(part => part.submit), 'SYNTHETIC_CODEX_SUBMIT_REQUIRED')
        }
        // Exercise the real adapter's per-generation parser with labelled,
        // deterministic synthetic counters, including the last-vs-total ABI.
        send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 1 }, last: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 1 } } } })
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: failed ? 'failed' : 'completed', error: failed ? { message: failed.exit.error } : null } } })
        activeTurn = undefined
      } else if (method === 'turn/interrupt') send({ id, result: {} })
      else send({ id, error: { code: -32601, message: 'synthetic_method_unsupported' } })
    } catch (error) {
      recordPeerFailure(config.directory, error, operation)
      send({ id, error: { code: -32603, message: 'synthetic_fixture_refused' } })
      if (activeTurn) {
        send({ method: 'turn/completed', params: { threadId, turn: { id: activeTurn, status: 'failed', error: { message: 'synthetic_fixture_refused' } } } })
        activeTurn = undefined
      }
    }
  }
}
