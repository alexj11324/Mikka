#!/usr/bin/env node
/** Epic #1687. Ordinary shared-account APIs, only inside the existing OIDC job.
 * Preflight sends no model prompt. Active retains useful Tasks and reports.
 * No database/provider credentials, startup timing, settings preparation or UI.
 * The operator separately verifies exact Run snapshots with authorized read-only
 * APP queries; this driver never claims that evidence or Environment setup.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { createSessionClient, decodeWire, smokeAcceptanceAccount, selectAcceptanceTeam,
  restoreAcceptanceWorkspace, subscriptionProof, watchRun } from './cloud-startup.mjs'

export const ORIGIN = 'https://app.aspectlylabs.com'
export const CASES = Object.freeze([
  { id: 'claude', harness: 'claude_code', model: 'claude-haiku-5-5', title: '核对领域模型上线与迁移说明',
    work: '审阅当前仓库的 README、开发/部署文档和已有数据库迁移。对照 Epic #1687 的 Workspace 级 Project、稳定 Task 编号、Team 归档保留和未知归属隔离要求，交付一份有文件定位的上线核对报告。Mikka 本体重点核对 docs/operations/domain-model-rollout.md 与实际 migration/backfill 顺序；其他仓库则明确说明现有结构如何接入这些约束。只报告可从实际文件证实的缺口；不存在的文件或契约必须标为未验证，不猜测。' },
  { id: 'codex', harness: 'codex', model: 'gpt-6-luna', title: '审阅项目仓库环境准入与历史兼容',
    work: '审阅当前仓库的执行、CI 和环境配置约束，交付 Epic #1687 的 Project/Repository/Environment 准入与历史兼容核对报告。Mikka 本体重点检查 lib/project-resources、queue/claim 和 daemon 的配置冻结、归档拒绝和 continuation；其他仓库则据其真实 README/CI 配置列出接入时需要的 branch、runtime、harness 约束。列出具体文件依据、风险和行动项；没有依据的部分标为未验证，不宣称已做生产测试。' },
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/
const REPOSITORY = /^v2\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/
const TERMINAL = new Set(['succeeded', 'completed', 'failed', 'stopped', 'cancelled'])
const SUCCESS = new Set(['succeeded', 'completed'])
const codes = new Set(['target_refused', 'inputs_conflict', 'mode_invalid', 'scope_invalid', 'scope_required', 'timeout_invalid', 'build_changed',
  'provision_permission', 'provision_ambiguous', 'provision_conflict',
  'response_invalid', 'http_refused', 'rpc_refused', 'login_failed', 'identity_failed', 'workspace_mismatch', 'project_missing',
  'project_archived', 'repository_denied', 'environment_missing', 'environment_incompatible', 'bot_missing', 'bot_busy',
  'chat_model_unbounded', 'paid_fallback_enabled', 'review_model_unbounded', 'profile_inventory_truncated', 'source_missing',
  'source_unavailable', 'profile_invalid', 'profile_unavailable', 'case_already_exists', 'task_scan_incomplete',
  'task_invalid', 'task_scope_mismatch', 'dispatch_refused', 'dispatch_missing', 'dispatch_multiple', 'stream_invalid',
  'run_scope_mismatch', 'run_model_mismatch', 'run_failed', 'report_missing', 'factory_blocked', 'attempt_budget_exceeded',
  'cleanup_failed', 'cleanup_scope_changed', 'dispatch_outcome_unknown', 'profile_cleanup_failed', 'session_cleanup_failed',
  'work_deadline', 'observation_failed', 'interrupted', 'acceptance_failed'])
const serverCodes = new Set(['authRequired', 'workspaceAccessDenied', 'projectNotFound', 'projectArchived', 'projectRepositoryDenied',
  'projectEnvironmentUnavailable', 'projectResourceConflict', 'issueNotFound', 'issueOutdated', 'runNotFound', 'runInvalid',
  'runChainEnded', 'modelUnavailable', 'modelNotAllowed', 'agentProfileUnavailable', 'agentProfileModelUnavailable',
  'agentProfileDecisionUnavailable', 'agentProfileVersionConflict', 'executionAccountUnavailable', 'subscriptionUnavailable',
  'subscriptionQuotaExhausted', 'subscriptionExpired', 'coordinatorUnavailable', 'issueToolsDisabled', 'submissionConflict',
  'factoryNotFound', 'factoryStale', 'factoryStopped', 'factoryRunStillActive', 'cloudComputerUnavailable', 'machineUnavailable'])
class DomainError extends Error {
  constructor(code, detail) { super(codes.has(code) ? code : 'acceptance_failed'); this.code = this.message; this.detail = detail }
}
const check = (condition, code, detail) => { if (!condition) throw new DomainError(code, detail) }
const uuid = value => typeof value === 'string' && UUID.test(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key))
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const textOf = value => typeof value?.text === 'string' ? value.text : Array.isArray(value?.content) ? value.content.map(textOf).join('\n') : ''
const stableUuid = value => { const hex = hash(value); return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32) }
export function publicFailure(error) {
  const result = { code: codes.has(error?.code) ? error.code : error?.name === 'AbortError' ? 'interrupted' : 'observation_failed' }
  if (error instanceof DomainError && typeof error.detail === 'string' && /^[a-z][a-z0-9_.]{0,79}$/.test(error.detail)) result.detail = error.detail
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599) result.httpStatus = error.httpStatus
  if (serverCodes.has(error?.serverCode)) result.serverCode = error.serverCode
  return result
}

export function domainOptions(env = process.env) {
  check(!env.DOMAIN_OTHER_AUDIT_SHA && (!env.DOMAIN_OTHER_AUDIT_LEASE || env.DOMAIN_OTHER_AUDIT_LEASE === 'false')
    && (!env.DOMAIN_OTHER_AUDIT_RECOVERY_RUN || env.DOMAIN_OTHER_AUDIT_RECOVERY_RUN === 'none'), 'inputs_conflict')
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && SHA.test(env.DOMAIN_MODEL_SHA ?? '') && env.GITHUB_SHA === env.DOMAIN_MODEL_SHA, 'target_refused')
  const mode = env.DOMAIN_MODEL_MODE ?? 'preflight'
  check(['preflight', 'provision', 'active'].includes(mode), 'mode_invalid')
  const timeoutMs = Number(env.DOMAIN_MODEL_TIMEOUT_MS ?? 480000)
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000, 'timeout_invalid')
  let scope = null
  if (env.DOMAIN_MODEL_SCOPE?.trim()) {
    try { scope = JSON.parse(env.DOMAIN_MODEL_SCOPE) } catch { throw new DomainError('scope_invalid', 'json') }
    check(exact(scope, ['workspaceId', 'projectId', 'repositoryKey', 'baseBranch', 'environmentId', 'botId', 'models'])
      && ['workspaceId', 'botId'].every(key => uuid(scope[key]))
      && ['projectId', 'environmentId'].every(key => scope[key] === undefined || uuid(scope[key]))
      && REPOSITORY.test(scope.repositoryKey ?? '') && scope.repositoryKey.split('/').every(part => !['.', '..'].includes(part))
      && (scope.baseBranch === undefined || typeof scope.baseBranch === 'string' && scope.baseBranch.length > 0 && scope.baseBranch.length <= 250
        && ![...scope.baseBranch].some(char => char.charCodeAt(0) <= 32 || '~^:?*[\\'.includes(char))
        && !scope.baseBranch.includes('..') && !scope.baseBranch.includes('@{') && !scope.baseBranch.startsWith('-')
        && scope.baseBranch.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')))
      && exact(scope.models, ['claude', 'codex']), 'scope_invalid', 'fields')
    for (const item of CASES) {
      const model = scope.models[item.id]
      check(exact(model, ['connectionId', 'profileId']) && uuid(model.connectionId)
        && (model.profileId === undefined || uuid(model.profileId)), 'scope_invalid', item.id)
    }
  }
  check(mode === 'preflight' || scope, 'scope_required')
  check(mode !== 'active' || scope.projectId && scope.environmentId, 'scope_required')
  check(mode !== 'provision' || !scope.projectId && scope.baseBranch && scope.repositoryKey === 'v2/github.com/alexj11324/mikka', 'scope_invalid', 'provision')
  return { sha: env.DOMAIN_MODEL_SHA, mode, scope, timeoutMs }
}

/** Preserve the existing cookie transport, but retain closed server refusal codes. */
export function domainClient(fetchImpl = fetch) {
  const transport = createSessionClient(ORIGIN, fetchImpl)
  const json = async (path, init, timeoutMs) => {
    const response = await transport.request(path, init, timeoutMs)
    let value
    try { value = await response.json() } catch { throw new DomainError('response_invalid') }
    if (!response.ok || value?.error) {
      const error = new DomainError('http_refused'); error.httpStatus = response.status
      error.serverCode = typeof value?.error === 'string' ? value.error : value?.error?.code
      throw error
    }
    check(value !== null && typeof value === 'object', 'response_invalid')
    return value
  }
  const rpc = async (action, args, extra = {}) => {
    const response = await json('/api/rpc', { ...post({ version: 1, action, args }), headers: {
      'content-type': 'application/json', 'x-mikka-rpc': '1', ...extra.headers } }, extra.timeoutMs)
    const value = decodeWire(response.result)
    if (response.ok !== true || value?.error || value?.ok === false) {
      const error = new DomainError('rpc_refused'); error.serverCode = value?.error?.code ?? value?.error ?? response.error?.code
      throw error
    }
    return value?.ok === true && 'data' in value ? value.data : value
  }
  return { ...transport, json, rpc }
}

async function inventory(client, shared) {
  const [projects, bots, resources, github, management, order, keys] = await Promise.all([
    client.rpc('projects.listWorkspaceProjects', [shared.workspaceId]), client.rpc('bots.listBots', []),
    client.rpc('project-resources.listProjectResources', [shared.workspaceId]), client.json('/api/integrations/github'),
    client.json('/api/factory/agent-profiles?workspaceId=' + shared.workspaceId + '&location=cloud'),
    client.rpc('model-order.getModelOrder', [shared.workspaceId]), client.json('/api/settings/api-keys?workspace=' + shared.workspaceId),
  ])
  check(Array.isArray(projects) && Array.isArray(bots) && Array.isArray(resources.environments)
    && Array.isArray(github.repositories) && github.viewerId === shared.ownerId && Array.isArray(management.profiles)
    && Array.isArray(management.catalog?.models) && Array.isArray(order.candidates), 'response_invalid')
  chatFallback(keys)
  check(management.profiles.length < 101, 'profile_inventory_truncated')
  const sources = order.candidates.filter(row => row.source?.kind === 'subscription' && uuid(row.source.connectionId)
    && row.credentialOwnerId === shared.adminId && CASES.some(item => row.harness === item.harness && row.model === item.model))
  return { projects, bots, resources, github, management, sources, keys }
}
const sameSource = (row, item, connectionId) => row?.harness === item.harness && row?.model === item.model
  && row.source?.kind === 'subscription' && row.source.connectionId === connectionId

/** listApiKeys exposes only the actor's public catalog. Match the existing
 * quotaFallbackKey/apiKeyChatBaseUrl contract: the fallback flag alone cannot
 * move a fixed Profile Run; a chat needs an owner key serving that exact model.
 * A teammate's shared key is not part of this catalog or that fallback path. */
function chatFallback(keys, modelId) {
  check(typeof keys?.apiKeyAfterQuota === 'boolean' && Array.isArray(keys.keys), 'response_invalid', 'api_key_catalog')
  for (const key of keys.keys) check(uuid(key?.id) && ['anthropic', 'openai', 'deepseek', 'kimi', 'custom'].includes(key.provider)
    && ['anthropic', 'openai'].includes(key.protocol) && (key.baseUrl === null || typeof key.baseUrl === 'string')
    && (key.provider !== 'custom' || typeof key.baseUrl === 'string' && URL.canParse(key.baseUrl)
      && ['https:', 'http:'].includes(new URL(key.baseUrl).protocol))
    && Array.isArray(key.models) && key.models.every(model => typeof model === 'string' && model.length > 0), 'response_invalid', 'api_key_catalog')
  return { enabled: keys.apiKeyAfterQuota, reachable: keys.apiKeyAfterQuota && keys.keys.some(key =>
    (key.provider !== 'custom' || key.protocol === 'openai') && (modelId ? key.models.includes(modelId) : CASES.some(item => key.models.includes(item.model)))) }
}

/** Automatic review selects among all enabled Profiles, not the producer's pin.
 * Require a closed set of fixed small subscriptions BEFORE any paid submission.
 * Fixed Profiles also refuse provider fallback; inherited/default routing cannot
 * prove this boundary from the ordinary API and is therefore blocked here. */
export function reviewGuard(state, scope, chatModelId) {
  check(!chatFallback(state.keys, chatModelId).reachable, 'paid_fallback_enabled')
  for (const profile of state.management.profiles.filter(row => row.enabled && !row.archivedAt)) {
    check(profile.model?.mode === 'fixed' && CASES.some(item => sameSource(profile.model, item, scope.models[item.id].connectionId))
      && (profile.harness === 'auto' || profile.harness === profile.model.harness), 'review_model_unbounded')
  }
}

async function basicScope(client, shared, state, scope) {
  check(scope.workspaceId === shared.workspaceId, 'workspace_mismatch')
  check(state.bots.some(row => row.id === scope.botId), 'bot_missing')
  const repository = scope.repositoryKey.slice('v2/github.com/'.length)
  check(state.github.repositories.some(row => row.fullName?.toLowerCase() === repository)
    && (state.resources.policy?.mode === 'inherit' || state.resources.policy?.mode === 'restricted'
      && state.resources.policy.repositoryKeys?.includes(scope.repositoryKey)), 'repository_denied')
  const menu = await client.rpc('execution-settings.getBotModelMenu', [scope.botId])
  check(menu.current?.kind === 'subscription' && menu.current.chosen === true && !menu.current.fallback
    && CASES.some(item => item.model === menu.current.modelId && item.harness === (menu.current.provider === 'claude' ? 'claude_code' : menu.current.provider))
    && (menu.current.available === true || menu.current.availability === 'checking'), 'chat_model_unbounded')
  reviewGuard(state, scope, menu.current.modelId)
  return { repository, chatModelId: menu.current.modelId }
}

async function selectedScope(client, shared, state, scope) {
  const { repository, chatModelId } = await basicScope(client, shared, state, scope)
  const project = state.projects.find(row => row.id === scope.projectId && row.workspaceId === scope.workspaceId)
  check(project, 'project_missing'); check(!project.archivedAt, 'project_archived')
  const selected = await client.rpc('project-resources.listProjectResources', [scope.workspaceId, scope.projectId])
  const repo = selected.repositories?.find(row => row.repositoryKey === scope.repositoryKey)
  const environmentId = repo?.environmentId ?? selected.environmentBindings?.find(row => row.isDefault)?.environmentId
  const environment = selected.environments?.find(row => row.id === environmentId && row.workspaceId === scope.workspaceId && !row.archivedAt)
  check(repo && (scope.baseBranch === undefined || scope.baseBranch === repo.baseBranch)
    && (selected.policy?.mode === 'inherit' || selected.policy?.mode === 'restricted' && selected.policy.repositoryKeys?.includes(scope.repositoryKey)), 'repository_denied')
  check(environment && environmentId === scope.environmentId
    && selected.environmentBindings.some(row => row.environmentId === environmentId), 'environment_missing')
  const config = environment.configuration
  check(config && ['any', 'cloud'].includes(config.runtime) && Array.isArray(config.repositoryKeys)
    && (!config.repositoryKeys.length || config.repositoryKeys.includes(scope.repositoryKey)), 'environment_incompatible')
  return { project, environment, repository, summary: { projectId: project.id, projectRevision: project.revision,
    coordinatorModel: chatModelId,
    policyRevision: selected.policy.revision, repositoryKey: scope.repositoryKey, baseBranch: repo.baseBranch,
    environmentId, environmentRevision: environment.revision, runtime: config.runtime, harness: config.harness } }
}

export function caseFingerprint(options, item) {
  const s = options.scope
  return hash(JSON.stringify([1687, options.sha, s.workspaceId, s.projectId, s.repositoryKey, s.environmentId,
    s.baseBranch ?? null, s.botId, item.id, s.models[item.id].connectionId, s.models[item.id].profileId ?? null]))
}

/** Project/environment create APIs allocate IDs on the server. A retained,
 * actor-owned Project carries the recovery receipt. A lost environment response
 * blocks a rerun until an operator supplies an exact visible environment ID;
 * name matching or an automatic second create would manufacture duplicates. */
async function provisionScope(client, shared, state, options, report, pin) {
  const scope = options.scope
  await basicScope(client, shared, state, scope)
  for (const item of CASES) modelSource(state, scope, item)
  const current = await client.json('/api/workspace?workspace=' + scope.workspaceId)
  check(current.workspace?.id === scope.workspaceId && current.currentUserId === shared.ownerId
    && ['owner', 'admin'].includes(current.role), 'provision_permission')
  const fingerprint = hash(JSON.stringify([1687, shared.ownerId, scope.workspaceId, scope.botId, scope.repositoryKey, scope.baseBranch]))
  const marker = '内部配置引用：Epic #1687；fingerprint=' + fingerprint
  const description = environmentId => '持续保留领域模型上线、稳定身份与仓库环境兼容性的实际审阅报告。\n\n' + marker
    + '\n环境回执：' + (environmentId ?? 'pending')
  const candidates = state.projects.filter(row => row.description?.includes(marker))
  check(candidates.length <= 1, 'provision_ambiguous')
  let project = candidates[0], createdNow = false
  const receipt = report.provision = { status: 'pending', fingerprint, objectsRetained: true,
    models: CASES.map(item => ({ case: item.id, available: modelSource(state, scope, item).available })) }
  if (project) {
    const tail = project.description.slice(project.description.lastIndexOf('\n环境回执：') + '\n环境回执：'.length)
    check(project.userId === shared.ownerId && project.leadUserId === shared.ownerId && project.workspaceId === scope.workspaceId
      && !project.archivedAt && (tail === 'pending' || uuid(tail)) && project.description === description(tail === 'pending' ? null : tail), 'provision_conflict')
    receipt.environmentId = tail === 'pending' ? undefined : tail
    if (scope.environmentId) check(!receipt.environmentId || receipt.environmentId === scope.environmentId, 'provision_conflict')
  }
  let environmentId = scope.environmentId ?? receipt.environmentId
  const compatibleEnvironment = environment => {
    const config = environment?.configuration
    check(environment?.workspaceId === scope.workspaceId && !environment.archivedAt && config?.runtime === 'cloud' && config.harness === 'any'
      && !config.setup && Object.keys(config.variables ?? {}).length === 0 && (config.secretIds ?? []).length === 0
      && Array.isArray(config.repositoryKeys) && (!config.repositoryKeys.length || config.repositoryKeys.includes(scope.repositoryKey)), 'provision_conflict', 'environment')
  }
  if (environmentId) compatibleEnvironment(state.resources.environments.find(row => row.id === environmentId))
  await pin()
  if (!project) {
    const created = await client.rpc('projects.saveProject', [{ workspaceId: scope.workspaceId, name: '领域模型上线审阅',
      summary: '核对 Project、Task 身份与仓库环境的上线约束，保留每次审阅报告。', description: description(environmentId),
      status: 'started', priority: 'normal', lead: '', leadUserId: shared.ownerId, memberIds: [shared.ownerId], startDate: '', targetDate: '' }])
    project = created.project; createdNow = true
    check(uuid(project?.id) && project.workspaceId === scope.workspaceId && project.userId === shared.ownerId
      && project.leadUserId === shared.ownerId && project.description === description(environmentId), 'provision_conflict')
  }
  receipt.projectId = project.id
  const existing = await client.rpc('project-resources.listProjectResources', [scope.workspaceId, project.id])
  check(Array.isArray(existing.repositories) && Array.isArray(existing.environmentBindings), 'response_invalid')
  const empty = existing.repositories.length === 0 && existing.environmentBindings.length === 0
  if (!environmentId) {
    check(createdNow && empty, 'provision_ambiguous', 'environment_receipt_required')
    const created = await client.rpc('project-resources.saveEnvironment', [{ workspaceId: scope.workspaceId, name: '领域模型只读审阅',
      configuration: { runtime: 'cloud', harness: 'any', variables: {}, secretIds: [], repositoryKeys: [scope.repositoryKey] } }])
    check(uuid(created.id), 'provision_conflict'); environmentId = created.id; receipt.environmentId = environmentId
  }
  if (project.description !== description(environmentId)) {
    check(empty && !(project.issueIds?.length), 'provision_conflict')
    project = (await client.rpc('projects.updateProjectProperties', [{ workspaceId: scope.workspaceId, id: project.id,
      revision: project.revision, changes: { description: description(environmentId) } }])).project
    check(project?.id === receipt.projectId && project.description === description(environmentId), 'provision_conflict')
  }
  if (empty) {
    check(!(project.issueIds?.length), 'provision_conflict')
    await client.rpc('project-resources.saveProjectResources', [{ workspaceId: scope.workspaceId, projectId: project.id, revision: project.revision,
      repositories: [{ repositoryKey: scope.repositoryKey, baseBranch: scope.baseBranch, environmentId, isPrimary: true }],
      environmentIds: [environmentId], defaultEnvironmentId: environmentId }])
  } else check(existing.repositories.length === 1 && existing.repositories[0].repositoryKey === scope.repositoryKey
    && existing.repositories[0].baseBranch === scope.baseBranch && existing.repositories[0].environmentId === environmentId
    && existing.repositories[0].isPrimary === true && existing.environmentBindings.length === 1
    && existing.environmentBindings[0].environmentId === environmentId && existing.environmentBindings[0].isDefault === true, 'provision_conflict')
  const activeScope = { ...scope, projectId: project.id, environmentId }
  const verified = await selectedScope(client, shared, await inventory(client, shared), activeScope)
  compatibleEnvironment(verified.environment)
  check(verified.project.description === description(environmentId) && verified.project.userId === shared.ownerId
    && verified.project.leadUserId === shared.ownerId && verified.project.memberIds?.includes(shared.ownerId), 'provision_conflict')
  Object.assign(receipt, { status: 'provisioned', environmentId, selection: verified.summary, activeScope })
}
export function caseDocument(options, item) {
  const fingerprint = caseFingerprint(options, item)
  return { fingerprint, content: { type: 'doc', content: [item.work,
    '先用工具读取实际 checkout commit 和相关文件，再给出有文件依据的中文报告。只读，不修改文件、分支或配置，不 commit/push，不开 PR，不发外部消息，不读取环境变量或凭据，不派生其他 Agent。报告留在本 Task；不使用占位 OK 作为交付。',
    '内部验收引用：Epic #1687；case=' + item.id + '；fingerprint=' + fingerprint,
  ].map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) } }
}

async function refuseDuplicate(client, shared, item, fingerprint) {
  let cursor = null
  const seen = new Set()
  for (let page = 0; page < 100; page++) {
    const result = await client.json('/api/issues/search?workspaceId=' + shared.workspaceId + '&limit=50&q=' + encodeURIComponent(item.title)
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    check(Array.isArray(result.items) && result.truncated === false, 'task_scan_incomplete')
    for (const row of result.items) if (row.ownerId === shared.ownerId && row.title === item.title) {
      const { issue } = await client.rpc('issues.getIssue', [row.id])
      check(issue?.workspaceId === shared.workspaceId && issue.userId === shared.ownerId, 'task_scope_mismatch')
      check(!textOf(issue.content).includes('fingerprint=' + fingerprint), 'case_already_exists')
    }
    if (result.nextCursor === null) return
    check(typeof result.nextCursor === 'string' && result.nextCursor.length <= 1024 && result.items.length > 0 && !seen.has(result.nextCursor), 'task_scan_incomplete')
    seen.add(result.nextCursor); cursor = result.nextCursor
  }
  throw new DomainError('task_scan_incomplete')
}

async function profileFor(client, state, scope, item, fingerprint, record) {
  const source = scope.models[item.id]
  modelReady(state, scope, item)
  let profile = source.profileId ? state.management.profiles.find(row => row.id === source.profileId) : null
  if (!source.profileId) {
    const id = stableUuid('profile:' + fingerprint)
    const definition = { name: '领域模型审阅 · ' + (item.id === 'claude' ? 'Haiku' : 'Luna'),
      description: 'Epic #1687 的一次正式只读报告；完成后归档此专用 Profile。', enabled: true,
      harness: item.harness, model: { mode: 'fixed', harness: item.harness, model: item.model,
        source: { kind: 'subscription', connectionId: source.connectionId } }, effort: 'low', roles: [], skills: [],
      instructions: '只读审阅实际仓库并交付有依据的报告。不修改代码、发布、发送外部消息、查看凭据或派生其他 Agent。' }
    record.createdProfile = { id, version: 1, confirmed: false }
    const confirm = value => {
      validProfile(value, item, source.connectionId)
      check(value.id === id && value.version === 1
        && isDeepStrictEqual(Object.fromEntries(Object.keys(definition).map(key => [key, value[key]])), definition), 'profile_invalid')
      return value
    }
    try { profile = confirm((await client.json('/api/factory/agent-profiles', post({ workspaceId: scope.workspaceId, requestId: id, profile: definition }))).profile) }
    catch (error) {
      try {
        profile = confirm((await client.json('/api/factory/agent-profiles/' + id + '?workspaceId=' + scope.workspaceId)).profile)
        record.profileCreateRecovered = true
      } catch { throw error }
    }
    record.createdProfile.confirmed = true
  }
  validProfile(profile, item, source.connectionId)
  Object.assign(record, { profileId: profile.id, profileVersion: profile.version, profileDigest: profile.digest })
  return profile
}

function validProfile(profile, item, connectionId) {
  check(profile?.enabled === true && !profile.archivedAt && uuid(profile.id) && Number.isInteger(profile.version) && profile.version > 0
    && /^[a-f0-9]{64}$/.test(profile.digest ?? '') && profile.model?.mode === 'fixed'
    && ['auto', item.harness].includes(profile.harness) && sameSource(profile.model, item, connectionId), 'profile_invalid')
}
function modelSource(state, scope, item) {
  const source = scope.models[item.id]
  check(state.sources.some(row => sameSource(row, item, source.connectionId)), 'source_missing')
  const candidate = state.management.catalog.models.find(row => sameSource(row, item, source.connectionId))
  check(candidate && typeof candidate.available === 'boolean', 'source_unavailable')
  if (source.profileId) validProfile(state.management.profiles.find(row => row.id === source.profileId), item, source.connectionId)
  return candidate
}
function modelReady(state, scope, item) { check(modelSource(state, scope, item).available === true, 'source_unavailable') }

// The normal tool preview may end after 200 characters. Only a complete UUID
// field from that exact tool call is a receipt; prose/Task-wide search is not.
function previewId(text, key) {
  if (typeof text !== 'string') return null
  const match = new RegExp('"' + key + '"\\s*:\\s*"([0-9a-f-]{36})"', 'i').exec(text)
  return uuid(match?.[1]) ? match[1] : null
}

async function dispatch(client, record, scope, item, timeoutMs) {
  const caseRef = '[1687:' + record.submissionId + ']'
  const input = { issueId: record.issueId, repo: scope.repositoryKey.slice('v2/github.com/'.length), target: 'cloud',
    profileId: record.profileId, requestKey: record.submissionId, readOnly: true,
    note: caseRef + ' 完成已有 Task 中的正式审阅报告。使用已选固定 Profile，只读，不换模型或账号，不创建另一个 Task。' }
  const text = '执行已有 Task ' + record.issueId + '，保留其 Project 关联。只调用一次 dispatch_run，参数：'
    + JSON.stringify(input) + '。不创建新 Task、不换 Profile、模型、订阅或运行位置；派发后仅确认已派发。'
  record.submitted = true
  await client.rpc('coordinator.sendCoordinatorMessage', [text, null, scope.botId, record.submissionId,
    { kind: 'cloud' }, null, [], { $mikka: 'undefined' }, record.profileId])
  const response = await client.request('/api/coordinator/stream?botId=' + scope.botId + '&wait=1', {}, timeoutMs)
  check(response.ok && response.body && response.headers.get('content-type')?.includes('application/x-ndjson'), 'stream_invalid')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', call, bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      bytes += value?.length ?? 0; check(bytes <= 4000000, 'stream_invalid')
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let event
        try { event = JSON.parse(line) } catch { throw new DomainError('stream_invalid') }
        if (event.type !== 'tool' || event.name !== 'dispatch_run') continue
        if (event.state === 'running' && previewId(event.input, 'issueId') === record.issueId) {
          const profileId = previewId(event.input, 'profileId'), requestKey = previewId(event.input, 'requestKey')
          // quote preserves the dispatch note independently of the truncated
          // input preview. An unrelated turn can use the same Task/Profile.
          if (requestKey !== record.submissionId && !(typeof event.quote === 'string' && event.quote.startsWith(caseRef + ' '))) continue
          check((!profileId || profileId === record.profileId) && (!requestKey || requestKey === record.submissionId), 'run_scope_mismatch')
          check(!call || call === event.call, 'dispatch_multiple'); call = event.call
        }
        if (!call || event.call !== call || event.state === 'running') continue
        if (event.state !== 'done') { record.dispatchSettled = true; const error = new DomainError('dispatch_refused'); error.serverCode = event.errorCode; throw error }
        const runId = previewId(event.output, 'runId')
        check(runId, 'dispatch_missing')
        record.dispatchSettled = true; record.runId = runId; record.placement = { kind: 'cloud' }; record.harness = item.harness
        return
      }
      if (done) throw new DomainError('dispatch_missing')
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

async function factoryState(client, record, shared) {
  if (!record.runId) return []
  const validate = (snapshot, id) => {
    check(snapshot.task?.id === id && snapshot.task.issueId === record.issueId && snapshot.task.userId === shared.ownerId
      && snapshot.task.workspaceId === shared.workspaceId && snapshot.task.botId === shared.botId && uuid(snapshot.task.sourceEventId)
      && Array.isArray(snapshot.attempts), 'run_scope_mismatch')
    return snapshot
  }
  if (record.factoryBinding) {
    const snapshot = validate(await client.json('/api/factory/tasks/' + record.factoryBinding.id), record.factoryBinding.id)
    check(snapshot.task.sourceEventId === record.factoryBinding.sourceEventId, 'cleanup_scope_changed')
    return [snapshot]
  }
  const { run } = await client.json('/api/runs/' + record.runId + '/evidence')
  check(run?.id === record.runId && run.issueId === record.issueId && run.botId === shared.botId
    && run.executionIdentity?.workspaceId === shared.workspaceId && run.executionIdentity.requester === shared.ownerId
    && run.agentProfile?.profileId === record.profileId && run.agentProfile.version === record.profileVersion
    && run.agentProfile.digest === record.profileDigest && run.agentProfile.source === 'explicit', 'run_scope_mismatch')
  const listing = await client.json('/api/factory/tasks?issueId=' + record.issueId)
  check(listing.issueId === record.issueId && Array.isArray(listing.tasks) && listing.tasks.length <= 50, 'run_scope_mismatch')
  const candidates = []
  for (const row of listing.tasks) {
    check(uuid(row.id) && row.issueId === record.issueId, 'run_scope_mismatch')
    const snapshot = await client.json('/api/factory/tasks/' + row.id)
    if (snapshot.attempts?.some(attempt => attempt.runId === record.runId)) candidates.push(validate(snapshot, row.id))
  }
  check(candidates.length === 1, 'run_scope_mismatch')
  const snapshot = candidates[0], producer = snapshot.attempts.filter(attempt => attempt.runId === record.runId)
  check(producer.length === 1 && producer[0].taskId === snapshot.task.id && producer[0].output?.requestEpoch === snapshot.task.sourceEventId, 'run_scope_mismatch')
  record.factoryBinding = { id: snapshot.task.id, sourceEventId: snapshot.task.sourceEventId }
  return [snapshot]
}

export function runReceipt(evidence, shared, scope, issueId) {
  const run = evidence?.run, identity = run?.executionIdentity
  const item = CASES.find(value => value.harness === run?.harness && value.model === run?.model)
  const subscriptions = identity?.resourceBindings?.filter(row => row.kind === 'subscription') ?? []
  const device = identity?.resourceBindings?.find(row => row.kind === 'device')
  check(uuid(run?.id) && run.issueId === issueId && item && run.credentialType === 'subscription'
    && ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing', ...TERMINAL].includes(run.status) && uuid(run.agentProfile?.profileId)
    && run.subscriptionRoute === (item.harness === 'codex' ? 'codex_cli' : 'claude_code_cli'), 'run_model_mismatch')
  check(identity?.version === 1 && identity.workspaceId === scope.workspaceId && identity.requester === shared.ownerId
    && identity.executionPrincipal === shared.ownerId && identity.outputOwner === shared.ownerId
    && identity.botOwner === shared.ownerId && identity.botId === shared.botId
    && identity.personalResourcePolicy === 'requester_only' && uuid(device?.id) && device.ownerId === shared.ownerId && device.access === 'owner'
    && subscriptions.length === 1 && subscriptions[0].ownerId === shared.adminId && subscriptions[0].access === 'workspace_share'
    && identity.billingAccount?.model?.kind === 'subscription' && identity.billingAccount.model.ownerId === shared.adminId
    && identity.billingAccount.model.resourceId === subscriptions[0].id && identity.billingAccount?.runtime?.kind === 'e2b'
    && identity.billingAccount.runtime.ownerId === shared.ownerId, 'run_scope_mismatch')
  return { runId: run.id, harness: run.harness, model: run.model, credentialType: run.credentialType,
    route: run.subscriptionRoute, status: run.status, profileId: run.agentProfile?.profileId ?? null,
    subscriptionBindingHash: hash(subscriptions[0].id).slice(0, 16), sharedIdentityVerified: true }
}

async function observeCase(client, record, shared, options, profile, deps) {
  const receipts = new Map(), factoryIds = new Set()
  await watchRun(client, record, options.timeoutMs, deps.WebSocketImpl, deps.now, undefined, {
    allowTerminal: true, signal: deps.signal,
    matches: event => (event.kind === 'factory_issue' && event.id === record.issueId) || (event.kind === 'factory_task' && factoryIds.has(event.id)),
    observe: async (detail, hooks) => {
      check(detail.thread?.id === record.runId && detail.thread.ownedByCurrentUser === true, 'run_scope_mismatch')
      record.lastStatus = detail.thread.status
      if (TERMINAL.has(detail.thread.status)) check(SUCCESS.has(detail.thread.status), 'run_failed')
      record.toolObserved ||= detail.chunks.some(row => row.chunk?.type === 'tool-output-available')
      record.repositoryObserved ||= detail.chunks.some(row => row.chunk?.type === 'data-run-stage' && row.chunk.data?.stage === 'repository' && row.chunk.data.ok === true)
      record.reportObserved ||= typeof detail.thread.detail?.summary === 'string' && detail.thread.detail.summary.trim().length >= 80
        || detail.chunks.filter(row => row.chunk?.type === 'text-delta').map(row => row.chunk.delta ?? row.chunk.text ?? '').join('').trim().length >= 80
      const snapshots = await factoryState(client, record, shared)
      check(snapshots.length > 0, 'response_invalid')
      const ids = new Set([record.runId])
      for (const snapshot of snapshots) {
        factoryIds.add(snapshot.task.id)
        for (const attempt of snapshot.attempts) if (attempt.runId && attempt.taskId === record.factoryBinding.id
          && attempt.output?.requestEpoch === record.factoryBinding.sourceEventId) {
          check(uuid(attempt.runId), 'run_scope_mismatch'); ids.add(attempt.runId); hooks.watchRun(attempt.runId)
        }
      }
      record.runIds = [...ids]
      check(ids.size <= 3, 'attempt_budget_exceeded')
      for (const id of ids) {
        const evidence = await client.json('/api/runs/' + id + '/evidence')
        const receipt = runReceipt(evidence, shared, options.scope, record.issueId)
        check(receipt.runId === id, 'run_scope_mismatch'); receipts.set(id, receipt)
      }
      record.runs = [...receipts.values()]
      record.factory = snapshots.map(({ task }) => ({ id: task.id, stage: task.stage, status: task.status }))
      for (const snapshot of snapshots) check(!['failed', 'blocked', 'cancelled', 'revoked'].includes(snapshot.task.status), 'factory_blocked')
      const settled = snapshots.every(({ task }) => task.stage === 'approval' && ['pending', 'waiting', 'passed'].includes(task.status)
        || task.stage === 'monitor' && task.status === 'passed')
      if (!SUCCESS.has(record.lastStatus) || !settled || !record.runs.every(run => SUCCESS.has(run.status))) return false
      check(record.toolObserved && record.repositoryObserved && record.reportObserved, 'report_missing')
      await subscriptionProof(client, record, shared, profile)
      hooks.checkActive()
      return true
    },
  })
}

async function cleanupCase(client, record, shared) {
  const cleanup = record.cleanup = { status: 'passed', tasksRetained: true, errors: [], machines: [] }
  // A dispatch preview alone is not cleanup authority. Only the verified
  // producer + Factory epoch can promote IDs into this set.
  const runIds = new Set(record.factoryBinding ? record.runIds ?? [] : [])
  const step = async (name, work) => { try { await work() } catch (error) { cleanup.status = 'failed'; cleanup.errors.push({ step: name, ...publicFailure(error) }) } }
  if (record.issueId) await step('factory', async () => {
    for (const snapshot of await factoryState(client, record, shared)) {
      for (const attempt of snapshot.attempts) if (attempt.taskId === record.factoryBinding.id
        && attempt.output?.requestEpoch === record.factoryBinding.sourceEventId && uuid(attempt.runId)) runIds.add(attempt.runId)
      if (record.status !== 'execution_observed' && !['passed', 'cancelled', 'revoked'].includes(snapshot.task.status)) {
        // Cancel revokes every attempt in this Factory, including historical
        // epochs. Its revision CAS is safe only when the whole affected set is ours.
        check(snapshot.attempts.every(attempt => attempt.taskId === record.factoryBinding.id
          && attempt.output?.requestEpoch === record.factoryBinding.sourceEventId && (!attempt.runId || runIds.has(attempt.runId))), 'cleanup_scope_changed')
        await client.json('/api/factory/tasks/' + snapshot.task.id, post({ binding: { taskId: snapshot.task.id, revision: snapshot.task.revision },
          eventId: stableUuid('cancel:' + record.fingerprint + ':' + snapshot.task.revision), action: 'cancel',
          reason: 'Epic #1687 的本次审阅执行未通过准入或证据核验；停止此任务的后续执行，保留报告和历史以便处理。' }))
      }
    }
  })
  // A transport failure after submission is not proof that its Coordinator
  // turn did not run. Reclaim known attempts, retain recovery state, and do not
  // report cleanup complete or archive the pin while dispatch is uncertain.
  if (record.submitted && !record.dispatchSettled) {
    cleanup.status = 'failed'; cleanup.errors.push({ step: 'dispatch', code: 'dispatch_outcome_unknown' })
  }
  await Promise.all([...runIds].map(id => step('run_and_machine', async () => {
    const detail = await client.rpc('agents.getIssueThread', [record.issueId, id])
    check(detail.thread?.id === id && detail.thread.ownedByCurrentUser === true, 'run_scope_mismatch')
    // The machine endpoint ends this exact Run. stopRun intentionally stops
    // later chain attempts too, which may belong to a new user submission.
    const ended = await client.json('/api/threads/' + id + '/machine', post({ action: 'end' }), 120000)
    check(ended.runId === id && ended.state === 'ended', 'cleanup_failed')
    const machine = await client.rpc('agents.getThreadMachine', [record.issueId, id])
    check(machine?.kind === 'cloud' && machine.state === 'ended' && machine.cloud === null, 'cleanup_failed')
    cleanup.machines.push({ runId: id, state: 'ended' })
  })))
  if (record.createdProfile && !record.createdProfile.confirmed) {
    cleanup.status = 'failed'; cleanup.errors.push({ step: 'own_profile_create', code: 'profile_cleanup_failed', detail: 'create_receipt_unknown' })
  }
  if (record.createdProfile?.confirmed && cleanup.status === 'passed') await step('own_profile_archive', async () => {
    const result = await client.json('/api/factory/agent-profiles/' + record.createdProfile.id,
      { ...post({ workspaceId: shared.workspaceId, version: record.createdProfile.version }), method: 'DELETE' })
    check(result.profile?.id === record.createdProfile.id && result.profile.archivedAt, 'profile_cleanup_failed')
    cleanup.profileArchived = true
  })
  record.runIds = [...runIds]
}

async function runCase(client, shared, options, item, deps, pin) {
  const document = caseDocument(options, item)
  const record = { case: item.id, harness: item.harness, model: item.model, status: 'blocked', phase: 'preflight',
    fingerprint: document.fingerprint, submissionId: stableUuid('submission:' + document.fingerprint) }
  const deadline = Math.min(deps.now() + options.timeoutMs, deps.workDeadline)
  const remaining = () => { const ms = deadline - deps.now(); check(ms > 0, 'work_deadline'); return ms }
  try {
    await pin()
    const state = await inventory(client, shared), selected = await selectedScope(client, shared, state, options.scope)
    record.selection = selected.summary
    check(['any', item.harness].includes(selected.environment.configuration.harness), 'environment_incompatible')
    const chat = await client.rpc('coordinator.pollCoordinatorChat', [shared.botId])
    check(chat.botId === shared.botId && chat.enabled === true && chat.working === false && !chat.streamRunId, 'bot_busy')
    await refuseDuplicate(client, shared, item, document.fingerprint)
    const profile = await profileFor(client, state, options.scope, item, document.fingerprint, record)
    await basicScope(client, shared, await inventory(client, shared), options.scope)
    record.phase = 'task_create'
    const { issue } = await client.rpc('issues.saveIssue', [{ workspaceId: shared.workspaceId, title: item.title,
      status: 'todo', priority: 'normal', content: document.content }])
    check(uuid(issue?.id) && Number.isInteger(issue.revision), 'task_invalid'); record.issueId = issue.id
    await client.rpc('projects.moveIssueToProject', [{ workspaceId: shared.workspaceId, issueId: issue.id, revision: issue.revision, projectId: options.scope.projectId }])
    const saved = (await client.rpc('issues.getIssue', [issue.id])).issue
    check(saved?.id === issue.id && saved.userId === shared.ownerId && saved.workspaceId === shared.workspaceId
      && saved.projectId === options.scope.projectId && typeof saved.identifier === 'string' && saved.identifier.length > 0
      && textOf(saved.content).includes('fingerprint=' + document.fingerprint), 'task_scope_mismatch')
    record.identifier = saved.identifier
    check(!deps.signal?.aborted, 'interrupted')
    await pin()
    await selectedScope(client, shared, await inventory(client, shared), options.scope)
    record.phase = 'dispatch'
    await dispatch(client, record, options.scope, item, remaining())
    record.phase = 'observe'
    await deps.observe(client, record, shared, { ...options, timeoutMs: remaining() }, profile, deps)
    const [{ issue: settled }, presentation] = await Promise.all([
      client.rpc('issues.getIssue', [record.issueId]), client.rpc('task-domain.getTaskPresentation', [record.issueId]),
    ])
    check(settled?.id === record.issueId && settled.userId === shared.ownerId && settled.workspaceId === shared.workspaceId
      && settled.projectId === options.scope.projectId && settled.identifier === record.identifier, 'task_scope_mismatch')
    const closed = ['done', 'canceled', 'duplicate'].includes(settled.status)
    check(presentation.version === 1 && ['backlog', 'todo', 'doing', 'review', 'done', 'canceled', 'duplicate'].includes(settled.status)
      && presentation.primaryStatus === settled.status
      && ['waiting', 'blocked', 'failed', 'running', 'queued', 'todo', 'done', 'canceled', 'duplicate'].includes(presentation.state)
      && [null, 'needs_input', 'approval', 'pr_review', 'blocked', 'quota', 'offline', 'blocked_by', 'flagged'].includes(presentation.reason)
      && (presentation.blockedBy === null || typeof presentation.blockedBy === 'string')
      && ['pending', 'running', 'todo', 'done'].includes(presentation.group)
      && [null, 'question', 'spec_review', 'pr_review', 'blocked', 'failed', 'dependency', 'flagged', 'quota'].includes(presentation.needsAction)
      && [null, 'question', 'run', 'failed', 'dependency', 'flagged', 'quota', 'factory'].includes(presentation.blockedReason)
      && (closed ? presentation.state === settled.status && presentation.group === 'done'
        : !['done', 'canceled', 'duplicate'].includes(presentation.state) && presentation.group !== 'done')
      && (presentation.reason !== 'approval' || presentation.state === 'waiting' && presentation.group === 'pending'
        && presentation.needsAction !== 'quota' && presentation.blockedReason !== 'quota')
      && [null, 'queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing', ...TERMINAL].includes(presentation.runStatus)
      && [null, 'triage', 'spec', 'implement', 'review', 'handoff', 'completed', 'cancelled'].includes(presentation.factoryStage)
      && [null, 'accepted', 'merged'].includes(presentation.completion)
      && (presentation.completion === null || presentation.factoryStage === 'completed'), 'response_invalid', 'task_presentation')
    record.taskState = { businessStatus: settled.status, primaryStatus: presentation.primaryStatus,
      state: presentation.state, reason: presentation.reason, blockedBy: presentation.blockedBy, group: presentation.group,
      needsAction: presentation.needsAction, blockedReason: presentation.blockedReason,
      runStatus: presentation.runStatus, factoryStage: presentation.factoryStage, completion: presentation.completion }
    await pin()
    record.status = 'execution_observed'
  } catch (error) { record.failure = publicFailure(error); if (record.submitted) record.status = 'failed' }
  finally { await cleanupCase(deps.cleanupClient, record, shared) }
  return record
}

async function preflightSummary(client, shared, state, options) {
  const context = await client.json('/api/workspace?workspace=' + shared.workspaceId)
  check(context.currentUserId === shared.ownerId && context.workspace?.id === shared.workspaceId
    && ['owner', 'admin', 'member', 'guest'].includes(context.role), 'workspace_mismatch')
  const projects = []
  for (const project of state.projects.toSorted((a, b) => a.id.localeCompare(b.id)).slice(0, 25)) {
    check(uuid(project.id) && project.workspaceId === shared.workspaceId, 'response_invalid')
    const resources = await client.rpc('project-resources.listProjectResources', [shared.workspaceId, project.id])
    projects.push({ projectId: project.id, revision: project.revision, archived: Boolean(project.archivedAt),
      repositories: resources.repositories.map(row => ({ repositoryKey: row.repositoryKey, baseBranch: row.baseBranch,
        environmentId: row.environmentId ?? resources.environmentBindings.find(binding => binding.isDefault)?.environmentId ?? null,
        githubAuthorized: state.github.repositories.some(repo => row.repositoryKey === 'v2/github.com/' + repo.fullName?.toLowerCase()),
        policyAllowed: resources.policy.mode === 'inherit' || resources.policy.repositoryKeys.includes(row.repositoryKey) })) })
  }
  const summary = { workspaceId: shared.workspaceId, workspaceRole: context.role, canProvision: ['owner', 'admin'].includes(context.role),
    selectionRequired: !options.scope?.projectId || !options.scope?.environmentId,
    counts: { projects: state.projects.length, bots: state.bots.length, environments: state.resources.environments.length,
      profiles: state.management.profiles.length, sharedSmallModelSources: state.sources.length, authorizedRepositories: state.github.repositories.length },
    authorizedRepositoryKeys: state.github.repositories.map(row => 'v2/github.com/' + row.fullName?.toLowerCase()).filter(key => REPOSITORY.test(key)).sort().slice(0, 25),
    authorizedRepositoriesTruncated: state.github.repositories.length > 25,
    projectsTruncated: state.projects.length > 25, projects, botIds: state.bots.map(row => row.id).filter(uuid).sort().slice(0, 25),
    botsTruncated: state.bots.length > 25, environmentsTruncated: state.resources.environments.length > 25,
    environments: state.resources.environments.slice(0, 25).map(row => ({ environmentId: row.id, revision: row.revision, archived: Boolean(row.archivedAt),
      runtime: row.configuration.runtime, harness: row.configuration.harness, repositoryCount: row.configuration.repositoryKeys.length })),
    sources: state.sources.map(row => ({ harness: row.harness, model: row.model, connectionId: row.source.connectionId,
      cloudAvailable: state.management.catalog.models.some(model => sameSource(model, CASES.find(item => item.harness === row.harness), row.source.connectionId) && model.available === true) })),
    profiles: state.management.profiles.map(row => ({ profileId: row.id, version: row.version, enabled: row.enabled,
      fixed: row.model?.mode === 'fixed', permittedSmallModel: CASES.some(item => row.model?.harness === item.harness && row.model?.model === item.model && row.model?.source?.kind === 'subscription') })),
    apiKeyFallbackDisabled: state.keys.apiKeyAfterQuota === false,
    ownChatKeyFallbackReachable: chatFallback(state.keys).reachable }
  if (options.scope?.projectId && options.scope?.environmentId) {
    try {
      const selected = await selectedScope(client, shared, state, options.scope)
      summary.selection = selected.summary; summary.activeScopeVerified = true
      summary.ownChatKeyFallbackReachable = chatFallback(state.keys, selected.summary.coordinatorModel).reachable
      summary.models = CASES.map(item => {
        try {
          check(['any', item.harness].includes(selected.environment.configuration.harness), 'environment_incompatible')
          modelReady(state, options.scope, item)
          return { case: item.id, ready: true, profile: options.scope.models[item.id].profileId ? 'existing_fixed' : 'create_dedicated_fixed' }
        } catch (error) { return { case: item.id, ready: false, failure: publicFailure(error) } }
      })
    }
    catch (error) { summary.activeScopeVerified = false; summary.failure = publicFailure(error) }
  }
  return summary
}

export async function runDomainAcceptance({ env = process.env, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket,
  now = Date.now, signal, observe = observeCase } = {}) {
  const report = { version: 1, issue: 1687, status: 'failed', origin: ORIGIN, startedAt: new Date(now()).toISOString(), cases: [],
    coverage: { environmentSetup: 'not_exercised_readonly', frozenSnapshot: 'requires_separate_authorized_app_read',
      taskAndReports: 'retained', startupThreshold: 'not_applicable', producerSubmissionsPerCase: 1, coordinatorTurnsPerCase: 1,
      builtInDecision: 'normal_platform_judgment_separate_from_cli_subscriptions',
      nativeAttempts: 'execute_and_normal_independent_checks_max_three_observed', hardDollarCap: false }, cleanup: { errors: [] } }
  const cleanupClient = domainClient(fetchImpl)
  // Leave eight minutes of the 30-minute job for exact-machine cleanup,
  // artifact writing and the normal sign-out even on slow API/provider paths.
  const workDeadline = now() + 22 * 60000
  const bound = timeout => { const remaining = workDeadline - now(); check(remaining > 0 && !signal?.aborted, 'work_deadline'); return Math.min(timeout ?? 30000, remaining) }
  const client = { ...cleanupClient,
    json: (path, init, timeout) => cleanupClient.json(path, init, bound(timeout)),
    request: (path, init, timeout) => cleanupClient.request(path, init, bound(timeout)),
    rpc: (action, args, extra = {}) => cleanupClient.rpc(action, args, { ...extra, timeoutMs: bound(extra.timeoutMs) }),
  }
  let signedIn = false, ownerId, originalWorkspaceId
  try {
    const options = domainOptions(env)
    Object.assign(report, { applicationSha: options.sha, mode: options.mode })
    const pin = async () => check((await client.json('/api/version')).build === options.sha, 'build_changed')
    await pin()
    const { email, password } = smokeAcceptanceAccount(env)
    const login = await client.request('/api/auth/sign-in/email', post({ email, password, rememberMe: false }))
    check(login.ok, 'login_failed'); signedIn = true
    const identity = await client.json('/api/auth/get-session?disableCookieCache=true')
    check(typeof identity.user?.id === 'string' && identity.user.email?.toLowerCase() === email.toLowerCase(), 'identity_failed')
    ownerId = identity.user.id
    const shared = await selectAcceptanceTeam(client, { ownerId, workspace: options.scope?.workspaceId }, id => { originalWorkspaceId = id })
    report.team = shared.evidence
    const state = await inventory(client, shared)
    report.preflight = await preflightSummary(client, shared, state, options)
    if (options.mode === 'preflight') report.status = report.preflight.failure || report.preflight.models?.some(row => !row.ready) ? 'blocked' : 'preflight_complete'
    else if (options.mode === 'provision') {
      await provisionScope(client, shared, state, options, report, pin)
      report.status = 'provisioned'
    } else {
      shared.botId = options.scope.botId
      const deps = { WebSocketImpl, now, signal, observe, cleanupClient, workDeadline }
      for (const item of CASES) {
        if (signal?.aborted) throw new DomainError('interrupted')
        report.cases.push(await runCase(client, shared, options, item, deps, pin))
      }
      report.status = report.cases.every(row => row.status === 'execution_observed' && row.cleanup.status === 'passed')
        ? 'execution_observed_pending_snapshot_review' : 'partial_or_blocked'
    }
    await pin()
  } catch (error) { report.status = 'failed'; report.failure = publicFailure(error) }
  finally {
    if (signedIn) {
      try { if (originalWorkspaceId) await restoreAcceptanceWorkspace(cleanupClient, ownerId, originalWorkspaceId); report.cleanup.workspaceRestored = Boolean(originalWorkspaceId) }
      catch (error) { report.cleanup.errors.push({ step: 'workspace_restore', ...publicFailure(error) }) }
      try { check((await cleanupClient.request('/api/auth/sign-out', post({}))).ok, 'session_cleanup_failed'); report.cleanup.sessionClosed = true }
      catch (error) { report.cleanup.errors.push({ step: 'sign_out', ...publicFailure(error) }) }
    }
    client.clear(); report.finishedAt = new Date(now()).toISOString()
    if (report.cleanup.errors.length) report.status = 'failed'
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    check(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--check-target', 'target_refused')
    const options = domainOptions()
    if (process.argv[2] === '--check-target') {
      const response = await fetch(ORIGIN + '/mikka/api/version', { redirect: 'error', headers: { 'cache-control': 'no-store' }, signal: AbortSignal.timeout(30000) })
      check(response.ok && (await response.json()).build === options.sha, 'build_changed')
      console.log('Domain acceptance target verified; no credentials read or model work sent.')
    } else {
      const abort = new AbortController()
      const stop = () => abort.abort()
      process.once('SIGTERM', stop); process.once('SIGINT', stop)
      const report = await runDomainAcceptance({ signal: abort.signal })
      await mkdir('production-work-domain-report', { recursive: true, mode: 0o700 })
      await writeFile('production-work-domain-report/report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
      console.log('Domain acceptance: ' + report.status)
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
      if (!['preflight_complete', 'provisioned', 'execution_observed_pending_snapshot_review'].includes(report.status)) process.exitCode = 1
    }
  } catch (error) { console.error('Domain acceptance: ' + JSON.stringify(publicFailure(error))); process.exitCode = 1 }
}
