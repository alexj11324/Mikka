import {execFileSync} from 'node:child_process'
import {appendFile, lstat, readFile, realpath} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {actionsMikkaRepository, hasGitHubOrigin, operationsRepositoryId, privateMikkaRepository} from './cloudflare-source.mjs'

const sha = /^[a-f0-9]{40}$/
const id = /^[1-9][0-9]{0,15}$/
const attempt = /^[1-9][0-9]{0,15}-[1-9][0-9]{0,15}$/
const receipt = /^[1-9][0-9]{0,15}-[1-9][0-9]{0,15}-[a-f0-9]{40}-[a-f0-9]{64}$/
const post = /^[1-9][0-9]{0,15}-[a-f0-9]{64}$/
const codes = new Set(['PUBLIC_OPERATIONS_INPUT_REQUIRED', 'PUBLIC_OPERATIONS_IDENTITY_REQUIRED',
  'PUBLIC_OPERATIONS_OIDC_REQUIRED', 'PUBLIC_OPERATIONS_OIDC_UNAVAILABLE', 'PUBLIC_OPERATIONS_SOURCE_REQUIRED'])
const check = (condition, code) => {
  if (!condition) throw Object.assign(new Error('Protected operations admission refused'), {code})
}

export function operationsInput(env) {
  const operation = env.MIKKA_OPERATION, action = env.MIKKA_OPERATION_ACTION
  const actions = {
    'operator-identity': ['verify'],
    'capture-retention': ['inspect', 'enable', 'remove'],
    'eve-world-resources': ['authorize'],
    'github-webhook-prepare': ['verify', 'prepare'],
    'cloudflare-billing-evidence': ['read'],
    'container-identity-metadata': ['inspect'],
    'private-source-download': ['deliver'],
    'vercel-project-billing': ['read'],
    'vercel-workflow-inventory': ['read'],
    'marketing-cloudflare-release': ['verify', 'release', 'rollback', 'inspect-legacy', 'release-legacy', 'rollback-legacy', 'cleanup-legacy'],
    'observe-cloudflare-runtime': ['read'],
    'runtime-native-alert': ['prepare', 'enable', 'disable'],
    'product-task-canary': ['verify', 'run'],
    'production-daemon-qualification': ['verify', 'run'],
  }
  check(Object.hasOwn(actions, operation) && actions[operation].includes(action), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
  check(sha.test(env.MIKKA_CF_OPERATIONS_SHA ?? ''), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
  const marketing = operation === 'marketing-cloudflare-release'
  const recovery = marketing && ['rollback', 'rollback-legacy', 'cleanup-legacy'].includes(action)
  for (const key of ['MIKKA_OPERATIONS_CI_RUN_ID', 'MIKKA_OPERATIONS_CI_RUN_ATTEMPT', 'MIKKA_OPERATIONS_CI_ARTIFACT_ID']) {
    check(recovery && !env[key] || id.test(env[key] ?? ''), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
  }
  if (marketing) {
    check(['alexj11324', 'aspectly-labs'].includes(env.MIKKA_MARKETING_GITHUB_OWNER || env.MIKKA_PRIVATE_GITHUB_OWNER || 'alexj11324'), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
    const receipt = env.MIKKA_OPERATION_RECEIPT
    if (receipt) check(['release', 'rollback', 'rollback-legacy', 'cleanup-legacy'].includes(action)
      && /^(?:private-[1-9][0-9]{0,15}|[1-9][0-9]{0,15}-[1-9][0-9]{0,15}-[a-f0-9]{40}-[a-f0-9]{64})$/.test(receipt), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
    if (recovery) check(Boolean(receipt), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
  }
  if (operation === 'private-source-download') check(id.test(env.MIKKA_SOURCE_COMMENT_ID ?? ''), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
  if (operation === 'vercel-project-billing') {
    const from = env.MIKKA_BILLING_FROM || '2026-11-01', to = env.MIKKA_BILLING_TO || '2026-11-12'
    for (const date of [from, to]) check(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
      && new Date(date).toISOString().slice(0, 10) === date, 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
    const days = (Date.parse(to) - Date.parse(from)) / 86400000
    check(days >= 1 && days <= 31, 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
  }
  if (operation === 'vercel-workflow-inventory') {
    check(sha.test(env.MIKKA_OPERATOR_PRODUCT_SHA ?? ''), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
    check(['true', 'false'].includes(env.MIKKA_OBSERVE_ORIGINAL_EVE), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
  }
  const original = value => attempt.test(value ?? '') || receipt.test(value ?? '')
  if (operation === 'observe-cloudflare-runtime') {
    check(sha.test(env.MIKKA_OPERATOR_PRODUCT_SHA ?? '') && post.test(env.MIKKA_PROMOTION_POST ?? '')
      && attempt.test(env.MIKKA_PREPARATION_RUN ?? ''), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
    const history = env.MIKKA_OBSERVATION_HISTORY || ''
    const windows = history.split(',')
    check(!history || history === 'auto' || windows.length === 8 && new Set(windows).size === 8
      && windows.every(original), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
    check(!env.MIKKA_PRESSURE_ENROLLMENT || original(env.MIKKA_PRESSURE_ENROLLMENT), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
  }
  if (operation === 'runtime-native-alert') {
    const scope = env.MIKKA_ALERT_SCOPE, enrollment = env.MIKKA_ALERT_ENROLLMENT || ''
    check(['filesystem', 'pressure'].includes(scope), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
    check(scope === 'filesystem' && action === 'prepare' ? !enrollment : original(enrollment), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
    if (action === 'enable') check(post.test(env.MIKKA_PROMOTION_POST ?? '')
      && attempt.test(env.MIKKA_PREPARATION_RUN ?? '') && original(env.MIKKA_OBSERVATION_RUN), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
    else {
      check(!env.MIKKA_PREPARATION_RUN && !env.MIKKA_OBSERVATION_RUN, 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
      check(scope === 'filesystem' ? !env.MIKKA_PROMOTION_POST
        : action === 'prepare' && !env.MIKKA_PROMOTION_POST || post.test(env.MIKKA_PROMOTION_POST ?? ''), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
    }
  }
  const target = env.WORLD_ENVIRONMENT || 'staging'
  check(['staging', 'production'].includes(target), 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
  return {operation, action, ...(operation === 'eve-world-resources' ? {target} : {})}
}

/** Select only the fixed reviewed request data; never a caller-supplied path or executable. */
export async function operationsProductInput(env = process.env, {directory = resolve('.mikka-cloud')} = {}) {
  operationsInput(env)
  const operation = env.MIKKA_OPERATION
  check(['vercel-workflow-inventory', 'observe-cloudflare-runtime', 'product-task-canary', 'production-daemon-qualification'].includes(operation),
    'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
  let source = env.MIKKA_OPERATOR_PRODUCT_SHA, browser = false
  if (['product-task-canary', 'production-daemon-qualification'].includes(operation)) {
    const file = join(directory, operation === 'product-task-canary'
      ? '.github/release-requests/product-task-canary.json' : 'docs/operations/releases/daemon-qualification.json')
    check((await lstat(file)).isFile(), 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
    const request = JSON.parse(await readFile(file, 'utf8'))
    source = operation === 'product-task-canary' ? request.public_sha : request.driver
    if (operation === 'product-task-canary') {
      check(Number.isSafeInteger(request.version) && request.version >= 1 && request.version <= 3, 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
      browser = request.version >= 2
    }
  }
  check(sha.test(source ?? ''), 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
  return {source, directory:operation === 'product-task-canary' ? 'public-source' : 'product', browser}
}

export function operationsIdentity(env) {
  const repository = actionsMikkaRepository(env)
  check(env.GITHUB_ACTIONS === 'true' && repository && env.GITHUB_ACTOR_ID === '183887963'
    && env.GITHUB_TRIGGERING_ACTOR === 'alexj11324' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_REF_NAME === 'main'
    && env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/cloudflare-operations.yml@refs/heads/main`
    && sha.test(env.GITHUB_SHA ?? '') && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA
    && id.test(env.GITHUB_RUN_ID ?? '') && id.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'PUBLIC_OPERATIONS_IDENTITY_REQUIRED')
  return {repository, operationsRepository: privateMikkaRepository('mikka-cloud', env),
    driverSource:env.GITHUB_SHA, operationsSource:env.MIKKA_CF_OPERATIONS_SHA}
}

export function operationsClaims(claims, env) {
  const identity = operationsIdentity(env)
  for (const [key, value] of Object.entries({iss:'https://token.actions.githubusercontent.com', aud:'mikka-infisical',
    repository:identity.repository, repository_id:env.GITHUB_REPOSITORY_ID,
    repository_owner_id:env.GITHUB_REPOSITORY_OWNER_ID, actor_id:'183887963',
    ref:'refs/heads/main', workflow_ref:env.GITHUB_WORKFLOW_REF, workflow_sha:env.GITHUB_SHA,
    sha:env.GITHUB_SHA, run_id:env.GITHUB_RUN_ID, run_attempt:env.GITHUB_RUN_ATTEMPT,
    environment:'cloudflare-runtime-release'})) {
    check(claims?.[key] === value, 'PUBLIC_OPERATIONS_OIDC_REQUIRED')
  }
  return identity
}

export async function admitOperations(env = process.env, fetchImpl = fetch) {
  const selection = operationsInput(env)
  operationsIdentity(env)
  let endpoint
  try { endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL) }
  catch (cause) { throw Object.assign(new Error('GitHub workload identity unavailable', {cause}), {code:'PUBLIC_OPERATIONS_OIDC_REQUIRED'}) }
  check(endpoint.protocol === 'https:' && endpoint.hostname.endsWith('.actions.githubusercontent.com')
    && !endpoint.username && !endpoint.password && !endpoint.port && !endpoint.hash
    && typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0,
  'PUBLIC_OPERATIONS_OIDC_REQUIRED')
  endpoint.searchParams.set('audience', 'mikka-infisical')
  let claims
  try {
    const response = await fetchImpl(endpoint, {headers:{authorization:'Bearer ' + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN},
      redirect:'error', cache:'no-store', signal:AbortSignal.timeout(20000)})
    check(response.ok, 'PUBLIC_OPERATIONS_OIDC_UNAVAILABLE')
    const payload = await response.json()
    check(typeof payload.value === 'string' && payload.value.length <= 16384 && payload.value.split('.').length === 3,
      'PUBLIC_OPERATIONS_OIDC_REQUIRED')
    claims = JSON.parse(Buffer.from(payload.value.split('.')[1], 'base64url'))
  } catch (cause) {
    throw Object.assign(new Error('GitHub workload identity unavailable', {cause}), {code:'PUBLIC_OPERATIONS_OIDC_UNAVAILABLE'})
  }
  return {...operationsClaims(claims, env), ...selection}
}

/** Check source using only the reviewed public driver, before installing or importing private code. */
export async function verifyOperationsCheckout(env = process.env, {directory = resolve('.mikka-cloud'), fetchImpl = fetch} = {}) {
  operationsInput(env)
  const identity = operationsIdentity(env)
  const git = args => execFileSync('git', ['-C', directory, ...args], {encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'],
    env:{PATH:env.PATH ?? process.env.PATH, HOME:env.HOME ?? process.env.HOME}}).trim()
  check(await realpath(directory) === resolve(directory)
    && git(['rev-parse', '--show-toplevel']) === directory
    && git(['rev-parse', 'HEAD']) === identity.operationsSource
    && hasGitHubOrigin(git(['remote', 'get-url', 'origin']), identity.operationsRepository)
    && git(['status', '--porcelain', '--untracked-files=no']) === '', 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
  const entry = 'operations/public-operations.mjs'
  check((await lstat(join(directory, entry))).isFile(), 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
  git(['ls-files', '--error-unmatch', entry])
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
  const read = async path => {
    const response = await fetchImpl(`https://api.github.com/repositories/${operationsRepositoryId}${path}`, {
      headers:{authorization:'Bearer ' + env.GH_TOKEN, accept:'application/vnd.github+json'},
      redirect:'error', cache:'no-store', signal:AbortSignal.timeout(20000),
    })
    check(response.ok, 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
    return response.json()
  }
  const repository = await read('')
  check(String(repository.id) === operationsRepositoryId && repository.full_name === identity.operationsRepository
    && repository.private === true && repository.fork === false
    && String(repository.owner?.id) === (identity.operationsRepository.startsWith('aspectly-labs/') ? '359279274' : '183887963'), 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
  const main = await read('/git/ref/heads/main')
  check(main.object?.type === 'commit' && sha.test(main.object.sha ?? ''), 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
  git(['merge-base', '--is-ancestor', identity.operationsSource, main.object.sha])
  return {status:'checked', operationsSource:identity.operationsSource}
}

/** Only the selected reviewed public driver and its locked SDK run in this checkout. */
export async function verifyOperationsProduct(env = process.env, {directory, fetchImpl = fetch} = {}) {
  operationsInput(env)
  const identity = operationsIdentity(env), selected = await operationsProductInput(env), source = selected.source
  directory ??= resolve('.mikka-cloud', selected.directory)
  const git = args => execFileSync('git', ['-C', directory, ...args], {encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'],
    env:{PATH:env.PATH ?? process.env.PATH, HOME:env.HOME ?? process.env.HOME}}).trim()
  check(await realpath(directory) === resolve(directory) && git(['rev-parse', '--show-toplevel']) === directory
    && git(['rev-parse', 'HEAD']) === source
    && hasGitHubOrigin(git(['remote', 'get-url', 'origin']), identity.repository)
    && git(['status', '--porcelain', '--untracked-files=no']) === '', 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
  const entries = env.MIKKA_OPERATION === 'vercel-workflow-inventory' ? ['scripts/ops/vercel-workflow-inventory.mjs']
    : env.MIKKA_OPERATION === 'observe-cloudflare-runtime' ? ['scripts/ops/cloudflare-container-logs.mjs', 'scripts/ops/cloudflare-capacity.mjs', 'scripts/ops/runtime-outcomes.mjs', 'scripts/ops/egress-monitor.mjs']
      : env.MIKKA_OPERATION === 'product-task-canary' ? ['scripts/acceptance/cloud-startup.mjs', 'scripts/release/ci-gate.mjs']
        : ['scripts/ops/production-mobile-daemon.mjs', 'scripts/acceptance/deployed-target.mjs']
  for (const entry of ['package.json', 'pnpm-lock.yaml', ...entries]) {
    check((await lstat(join(directory, entry))).isFile(), 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
    git(['ls-files', '--error-unmatch', entry])
  }
  check(typeof env.MIKKA_PUBLIC_ACTIONS_TOKEN === 'string' && env.MIKKA_PUBLIC_ACTIONS_TOKEN.length > 0,
    'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
  const path = `/compare/${source}...${identity.driverSource}`
  const response = await fetchImpl('https://api.github.com/repositories/1427517699' + path + '?per_page=1', {
    headers:{authorization:'Bearer ' + env.MIKKA_PUBLIC_ACTIONS_TOKEN, accept:'application/vnd.github+json'},
    redirect:'error', cache:'no-store', signal:AbortSignal.timeout(20000),
  })
  check(response.ok, 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
  const comparison = await response.json()
  check(comparison.url === `https://api.github.com/repos/${identity.repository}${path}`
    && comparison.base_commit?.sha === source && comparison.merge_base_commit?.sha === source
    && ['identical', 'ahead'].includes(comparison.status) && comparison.behind_by === 0
    && Number.isSafeInteger(comparison.ahead_by) && comparison.ahead_by >= 0, 'PUBLIC_OPERATIONS_SOURCE_REQUIRED')
  return {status:'checked', productSource:source}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length === 3 && process.argv[2] === 'source') console.log(JSON.stringify(await verifyOperationsCheckout()))
    else if (process.argv.length === 3 && process.argv[2] === 'product') console.log(JSON.stringify(await verifyOperationsProduct()))
    else if (process.argv.length === 3 && process.argv[2] === 'product-input') {
      const selected = await operationsProductInput()
      await appendFile(process.env.GITHUB_OUTPUT, `source=${selected.source}\ndirectory=${selected.directory}\nbrowser=${selected.browser}\n`)
      console.log(JSON.stringify({status:'selected', productSource:selected.source}))
    }
    else {
      check(process.argv.length === 2, 'PUBLIC_OPERATIONS_INPUT_REQUIRED')
      const selected = await admitOperations()
      await appendFile(process.env.GITHUB_OUTPUT, `owner=${selected.operationsRepository.split('/')[0]}\nrepository=${selected.operationsRepository}\n`)
      console.log(JSON.stringify({status:'admitted', operation:selected.operation, action:selected.action, driverSource:selected.driverSource}))
    }
  } catch (error) {
    console.error(JSON.stringify({status:'refused', code:codes.has(error.code) ? error.code : ['source', 'product', 'product-input'].includes(process.argv[2]) ? 'PUBLIC_OPERATIONS_SOURCE_REQUIRED' : 'PUBLIC_OPERATIONS_IDENTITY_REQUIRED'}))
    process.exitCode = 1
  }
}
