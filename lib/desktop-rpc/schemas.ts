import { saveEnvironmentInput, projectDefaultEnvironmentInput, projectResourcesInput, workspaceRepositoryPolicyInput } from '@/lib/project-resources/contracts'
import { createOnlyCommand } from '@/lib/task-create-command'
import { taskPresentationsInput } from '@/lib/task-presentation-input'
import { z } from 'zod'
import { projectInput, projectPatch } from '@/lib/project-input'
import { assigneeSchema, delegateSchema, blockFlagSchema, labelSchema, pullRequestSchema } from '@/lib/issue-metadata'
import { ISSUE_STATUS_CODES, ISSUE_PRIORITY_CODES } from '@/lib/issue-meta'
import { taskDestinationSchema } from '@/lib/task-destination'
import { agentProfileReferenceSchema } from '@/lib/factory/agent-profile-reference'
import { taskTitleInputSchema } from '@/lib/task-title-input'
import { API_KEY_PRESETS } from '@/lib/model-api-key-providers'
import { userImageInputsSchema } from '@/lib/coordinator/user-attachments'
import { setAppPolicyInput } from '@/lib/app-policy/apps'
import { POINTS_PURCHASE_AMOUNTS } from '@/lib/billing/hosted-usage'
import { MAX_READ_BATCH, READ_BATCH_ACTIONS, type ReadBatchCall } from './read-batch-contract'
import { USER_FACT_KINDS } from '@/lib/profile/kinds'

const uuid = z.uuid()
const id = z.string().min(1).max(200)
const text = (max: number) => z.string().max(max)
const bool = z.boolean()
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const workspace = uuid.optional()
const bot = uuid.nullable()
const version = z.string().regex(/^[0-9a-f]{32}$/)
const tuple = (...items: z.ZodType[]): z.ZodType => items.length ? z.tuple(items as [z.ZodType, ...z.ZodType[]]) : z.tuple([])
const object = z.strictObject
const oneId = tuple(uuid)
const none = tuple()
const inWorkspace = tuple(workspace)
const memoryScope = z.discriminatedUnion('kind', [
  object({ kind: z.literal('global'), ids: z.tuple([]) }),
  object({ kind: z.literal('workspaces'), ids: z.array(uuid).min(1).max(50) }),
  object({ kind: z.literal('projects'), ids: z.array(uuid).min(1).max(50) }),
])
const secret = text(65_536)
const scope = z.discriminatedUnion('type', [object({ type: z.literal('workspace') }), object({ type: z.literal('repository'), repository: text(2048).min(1) })])
const secretBase = { name: text(200).min(1), kind: z.enum(['secret', 'env']), value: secret, note: text(2000).optional() }
const importBase = { text: text(2 * 1024 * 1024), masked: bool, onConflict: z.enum(['replace', 'skip']) }
const json: z.ZodType = z.lazy(() => z.union([z.null(), z.string(), z.boolean(), z.number().finite(), z.array(json), z.record(z.string(), json)]))
const document = z.object({ type: z.literal('doc'), content: z.array(json).optional(), attrs: z.record(z.string(), json).optional() }).strict()
  .refine(value => JSON.stringify(value).length <= 250_000)
const metadata = object({
  assignee: assigneeSchema.pick({ kind: true, id: true }).strict().nullable().optional(),
  delegate: delegateSchema.pick({ kind: true, id: true }).strict().nullable().optional(),
  project: text(100).trim().min(1).nullable().optional(), labels: z.array(labelSchema.strict()).max(12).optional(),
  pullRequests: z.array(pullRequestSchema.strict()).max(10).optional(), dueDate: z.iso.date().nullable().optional(),
  estimate: z.number().int().min(0).max(100).nullable().optional(),
  block: blockFlagSchema.strict().nullable().optional(),
})
const quote = object({ artifactId: uuid, version: positive, kind: z.enum(['text', 'element']), text: text(2000).trim().min(1), label: text(200).optional(), selector: text(1000).optional() })
const note = object({
  n: positive, kind: z.enum(['element', 'region']), url: z.url({ protocol: /^https?$/ }).max(2000),
  label: text(200).trim().min(1), note: text(500).trim().min(1), selector: text(1000).optional(),
  rect: object({ x: z.number().finite(), y: z.number().finite(), width: z.number().min(0), height: z.number().min(0), viewportWidth: z.number().min(0), viewportHeight: z.number().min(0) }).optional(),
})
const harness = z.enum(['claude_code', 'codex'])
const orderChange = z.discriminatedUnion('kind', [
  object({ kind: z.literal('add'), entries: z.array(object({ harness, model: text(128).trim().min(1), source: z.discriminatedUnion('kind', [object({ kind: z.literal('subscription'), connectionId: uuid }), object({ kind: z.literal('api_key'), keyId: uuid })]) })).min(1).max(400), at: count.optional() }),
  object({ kind: z.literal('remove'), id }), object({ kind: z.literal('reorder'), ids: z.array(id).max(400) }),
  object({ kind: z.literal('location'), location: z.enum(['cloud', 'local']) }), object({ kind: z.literal('autoRouting'), enabled: bool }),
  object({ kind: z.literal('preferred'), harness }), object({ kind: z.literal('harness'), id, harness }),
])
const apiKey = z.discriminatedUnion('provider', [
  object({ provider: z.enum(API_KEY_PRESETS), apiKey: text(512).trim().min(8) }),
  object({ provider: z.literal('custom'), name: text(60).trim().min(1), baseUrl: text(500).trim().min(1), protocol: z.enum(['anthropic', 'openai']), apiKey: text(512).trim().min(8), models: z.array(text(128).trim().min(1)).max(200).optional() }),
])
const preferences = object({
  proactive: bool, pushDecide: bool, pushReview: bool, pushFinished: bool, pushBriefing: bool,
  pushWhen: z.enum(['always', 'away']), memoryEnabled: bool, sendKey: z.enum(['enter', 'modEnter']),
  personalInstructions: text(8000).transform(value => value.trim()).refine(value => [...value].length <= 2000), dailySuggestions: bool,
}).partial()
const listPositions = (limit: number) => z.array(object({ id: uuid, version })).max(limit)
  .refine(rows => new Set(rows.map(row => row.id)).size === rows.length)
const coordinatorRead = tuple(bot.optional(), version.optional(), object({ after: count, cursor: count, prefix: version,
  restoreToolMetadata: z.literal(true).optional(), sourceIds: z.array(uuid).max(400).optional(), artifactIds: z.array(uuid).max(400).optional(),
}).optional())
const slug = text(64).min(3).regex(/^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/)
const avatar = z.instanceof(FormData).superRefine((form, context) => {
  const entries = [...form.entries()]
  const file = entries[0]?.[1]
  if (entries.length !== 1 || entries[0]?.[0] !== 'avatar' || !(file instanceof Blob)
    || file.size > 200 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) context.addIssue({ code: 'custom' })
})
const readBatch: z.ZodType = tuple(z.array(object({ action: z.enum(READ_BATCH_ACTIONS), args: z.array(z.unknown()) }))
  .min(1).max(MAX_READ_BATCH)).superRefine((value, context) => {
  const [calls] = value as [ReadBatchCall[]]
  for (const [index, call] of calls.entries()) {
    if (!desktopActionSchemas[call.action].safeParse(call.args).success) {
      context.addIssue({ code: 'custom', path: [0, index, 'args'], message: 'desktop_rpc_request_invalid' })
    }
  }
})

/** Explicit transport whitelist. Optional parameters and array lengths are
 * checked here before the original action performs its ownership checks. */
export const desktopActionSchemas = {
  'desktop.readBatch': readBatch,
  'task-domain.getTaskPresentation': oneId,
  'task-domain.getTaskPresentations': tuple(taskPresentationsInput),
  'teams.getTeamLifecycleImpact': oneId,
  'teams.getTeamLifecycleAudit': tuple(uuid, uuid),
  'teams.archiveTeam': oneId,
  'teams.restoreTeam': oneId,
  'teams.removeTeamGrouping': tuple(uuid, text(120)),
  'project-resources.listProjectResources': tuple(uuid, uuid.optional()),
  'project-resources.setProjectDefaultEnvironment': tuple(projectDefaultEnvironmentInput),
  'project-resources.saveEnvironment': tuple(saveEnvironmentInput),
  'project-resources.saveProjectResources': tuple(projectResourcesInput),
  'project-resources.saveWorkspaceRepositoryPolicy': tuple(workspaceRepositoryPolicyInput),
  'desktop.bootstrap': inWorkspace,
  'desktop.session': none,
  'desktop.accounts': none,
  'desktop.workspaceLink': tuple(slug),
  'account.updateDisplayName': tuple(text(80).trim().min(1)),
  'account.uploadAvatar': tuple(avatar),
  'account.getPasswordStatus': none,
  'account.listSessions': none,
  'account.listSharedLinks': none,
  'account.changePassword': tuple(object({ currentPassword: text(128).min(1), newPassword: text(128).min(8), revokeOtherSessions: bool.optional() })),
  'account.setPassword': tuple(object({ newPassword: text(128).min(8) })),
  'account.revokeSession': tuple(id),
  'account.revokeOtherSessions': none,
  'account.requestDataExport': none,
  'account.deleteAccount': tuple(object({ email: z.email().max(254) })),
  'agents.listDevices': none,
  'agents.pollDevices': none,
  'agents.setDeviceEnabled': tuple(object({ deviceId: uuid, enabled: bool })),
  'agents.renameDevice': tuple(uuid, text(100).trim().min(1)),
  'agents.removeDevice': oneId,
  'agents.listAgents': none,
  'agents.pollIssueThreads': oneId,
  'agents.findThreadIssue': oneId,
  'agents.getIssueThread': tuple(uuid.nullable(), uuid, object({ chain: text(4000), runId: uuid.nullable(), seq: count, runs: count, count }).nullish()),
  'agents.getThreadChanges': tuple(uuid.nullable(), uuid),
  'agents.getThreadMachine': tuple(uuid.nullable(), uuid),
  'agents.getThreadInstructions': tuple(uuid.nullable(), uuid),
  'agents.sendIssueThreadReply': tuple(object({ issueId: uuid.nullable(), runId: uuid, text: text(10_000).min(1), requestId: uuid.optional(), retryOriginalSession: z.literal(true).optional(), questionWakeGeneration: uuid.optional() })),
  'agents.getThreadName': oneId,
  'agents.stopRun': oneId,
  'agents.resumeQuotaPausedRunOnApiKey': oneId,
  'agents.retryQuotaPausedRun': oneId,
  'agents.sendDeviceCommand': tuple(object({ deviceId: uuid, kind: z.enum(['redetect', 'restart', 'update']) })),
  'app-policy.getAppPolicy': inWorkspace,
  'app-policy.updateAppPolicy': tuple(setAppPolicyInput, workspace),
  'artifacts.listArtifacts': none,
  'artifacts.listRunArtifacts': oneId,
  'artifacts.getArtifact': oneId,
  'artifacts.getArtifactText': tuple(uuid, positive),
  'artifacts.shareArtifact': oneId,
  'artifacts.stopSharingArtifact': oneId,
  'audit-log.listAuditLog': tuple(object({ filter: z.enum(['all', 'security']).optional(), cursor: text(200).nullish() }).optional(), workspace),
  'billing.getBilling': inWorkspace,
  'billing.getCreditBilling': inWorkspace,
  'billing.cardVerificationStatus': inWorkspace,
  'billing.getHostedUsage': inWorkspace,
  'billing.openBillingPortal': tuple(text(2048).min(1), workspace),
  'billing.startPlanCheckout': tuple(text(2048).min(1), workspace),
  'billing.startPointsPurchase': tuple(uuid, z.number().refine(amount => (POINTS_PURCHASE_AMOUNTS as readonly number[]).includes(amount))),
  'billing.startChatPointsPurchase': tuple(z.number().finite().positive(), bot),
  'billing.startCardVerification': inWorkspace,
  'bots.listBots': none,
  'bots.pollBots': none,
  'bots.createBot': tuple(object({ name: text(200).trim().min(1), color: text(50).min(1), shape: text(50).min(1), model: text(1000).nullish(), repository: text(2048).nullish() })),
  'bots.updateBot': tuple(object({ botId: uuid, name: text(200).trim().min(1).optional(), color: text(50).min(1).optional(), shape: text(50).min(1).optional(), publicRole: text(2000).optional() })),
  'bots.listWorkspaceBots': none,
  'bots.listBotsForWorkspace': oneId,
  'collaboration.exchangeDocument': tuple(object({ id: uuid, vector: text(1_400_000).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(), update: text(1_400_000).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(), seed: text(1_400_000).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(), known: version.optional() })),
  'collaboration.listMembers': oneId,
  'collaboration.inviteMember': tuple(uuid, z.email().max(254)),
  'collaboration.removeMember': tuple(uuid, id),
  'collaboration.setMemberRole': tuple(uuid, id, z.enum(['owner', 'member'])),
  'collaboration.setMemberSubscribed': tuple(uuid, id, bool),
  'coordinator.pollCoordinatorChat': coordinatorRead,
  'coordinator.syncCoordinatorChat': coordinatorRead,
  'coordinator.coordinatorHistory': tuple(bot, count, z.number().int().min(1).max(200).optional()),
  'coordinator.coordinatorCitationSources': tuple(z.array(uuid).min(1).max(50)),
  'coordinator.coordinatorReasoning': tuple(bot, z.array(positive).min(1).max(50)),
  'coordinator.pollBotChatSummaries': none,
  'coordinator.sendCoordinatorMessage': tuple(text(10_000), quote.nullish(), bot.optional(), uuid.optional(), taskDestinationSchema.optional(), z.array(note).max(20).nullish(), userImageInputsSchema.optional(), positive.optional(), agentProfileReferenceSchema.optional(), workspace, taskTitleInputSchema.optional()),
  'coordinator.welcomeCoordinator': tuple(bot.optional()),
  'coordinator.stopCoordinatorTurn': tuple(bot.optional()),
  'coordinator.retryCoordinatorTurn': tuple(bot.optional()),
  'coordinator.sendSuggestion': oneId,
  'coordinator.issueCreationAvailable': none,
  'desktop-notifications.chooseDesktopNotifications': tuple(z.array(object({ id: text(300), issueId: text(100), kind: z.enum(['awaiting', 'failed', 'finished']) })).max(20)),
  'execution-settings.getBotModelMenu': tuple(bot),
  'execution-settings.refreshBotModelMenuAction': tuple(bot),
  'execution-settings.chooseBotModel': tuple(bot, text(1000).min(1)),
  'issue-metadata.getIssuePropertyOptions': oneId,
  'issue-metadata.updateIssueMetadata': tuple(object({ id: uuid, revision: positive, patch: metadata, inviteEmail: z.email().max(254).optional() })),
  'issue-operations.listIssueConnections': oneId,
  'issue-operations.updateIssueRelation': tuple(object({ id: uuid, revision: positive, targetId: uuid.nullable(), kind: z.enum(['parent', 'child', 'related', 'blockedBy', 'blocks', 'duplicate']), remove: bool.optional() })),
  'issue-operations.createLinkedIssue': tuple(object({ id: uuid, revision: positive, kind: z.enum(['child', 'duplicate']), title: text(200).optional(), includeSubissues: bool.optional() })),
  'issue-operations.toggleIssuePreference': tuple(object({ id: uuid, kind: z.enum(['favorite', 'subscribe']) })),
  'issue-operations.getDeletedIssue': oneId,
  'issue-operations.setIssueDeleted': tuple(object({ id: uuid, revision: positive.optional(), restore: bool.optional() })),
  'issue-prefix.getIssuePrefixState': none,
  'issue-prefix.saveIssuePrefix': tuple(object({ prefix: text(20).min(1) })),
  'issues.listIssues': none,
  'issues.pollIssues': tuple(version.optional(), listPositions(100).optional()),
  'issues.syncIssueList': tuple(version.optional(), listPositions(100).optional()),
  'issues.listWorkspaceIssues': oneId,
  'issues.getIssue': oneId,
  'issues.pollIssue': tuple(uuid, version.optional()),
  'issues.createTaskOnly': tuple(createOnlyCommand),
  'issues.saveIssue': tuple(object({ id: uuid.optional(), revision: positive.optional(), title: text(200).trim().min(1), content: document, status: z.enum(ISSUE_STATUS_CODES), priority: z.enum(ISSUE_PRIORITY_CODES) })),
  'issues.promoteIssueToTeam': tuple(object({ requestId: uuid, issueId: uuid, revision: positive, teamId: uuid, expectedTeamId: uuid.nullable() })),
  'issues.moveIssue': tuple(object({ id: uuid, status: z.enum(ISSUE_STATUS_CODES), revision: positive })),
  'issues.changeIssuePriority': tuple(object({ id: uuid, priority: z.enum(ISSUE_PRIORITY_CODES), revision: positive })),
  'issues.listIssueVersions': oneId,
  'issues.pollIssueVersionSummaries': tuple(uuid, version.optional(), listPositions(50).optional()),
  'issues.setIssueScope': tuple(object({ id: uuid, revision: positive, scope: z.enum(['personal', 'workspace']) })),
  'linear-sync.getLinearIntegrationState': none,
  'linear-sync.getLinearBoardSync': none,
  'linear-sync.startLinearOAuth': none,
  'linear-sync.listLinearTeamOptions': none,
  'linear-sync.enableLinearTeam': tuple(object({ teamId: id })),
  'linear-sync.disableLinearTeam': oneId,
  'linear-sync.retryLinearIssue': oneId,
  'linear-sync.retryLinearDelivery': oneId,
  'linear-sync.disconnectLinearAccount': none,
  'link-preview.getLinkPreview': tuple(z.url({ protocol: /^https?$/ }).max(2048)),
  'memory.getMemory': none,
  'memory.setMemory': tuple(bool),
  'memory.clearMemory': none,
  'memory.addFact': tuple(object({ requestId: uuid, kind: z.enum(USER_FACT_KINDS), subject: text(200).trim().min(1), scope: memoryScope.optional() })),
  'memory.removeFact': oneId,
  'memory.updateFact': tuple(uuid, text(200)),
  'memory.reviewFact': tuple(uuid, z.enum(['approve', 'reject'])),
  'memory.setFactScope': tuple(uuid, memoryScope),
  'memory.undoRemoveFact': oneId,
  'model-api-keys.getApiKeys': inWorkspace,
  'model-api-keys.refetchApiKeyModels': tuple(uuid, workspace),
  'model-api-keys.updateApiKeyAfterQuota': tuple(bool, workspace),
  'model-api-keys.createApiKey': tuple(apiKey, workspace),
  'model-api-keys.deleteApiKey': tuple(uuid, workspace),
  'model-api-keys.updateApiKeyShare': tuple(object({ id: uuid, shared: bool }), workspace),
  'enabled-models.getEnabledModels': tuple(uuid),
  'enabled-models.setModelEnabled': tuple(uuid, z.union([uuid, z.literal('hosted')]), text(128).min(1), bool),
  'enabled-models.setAllModelsEnabled': tuple(uuid, z.union([uuid, z.literal('hosted')]), bool),
  'enabled-models.setAutoEnable': tuple(uuid, uuid, bool),
  'enabled-models.markModelsSeen': tuple(uuid, z.union([uuid, z.literal('hosted')])),
  'model-order.getModelOrder': inWorkspace,
  'model-order.checkModelOrderQuota': tuple(uuid, workspace),
  'model-order.refreshSubscriptionModels': tuple(uuid, workspace),
  'model-order.changeModelOrder': tuple(orderChange, workspace),
  'onboarding.completeOnboarding': none,
  'onboarding.resetOnboarding': none,
  'pending-actions.decidePendingAction': tuple(uuid, bool),
  'personal-policy.getSharePolicy': inWorkspace,
  'personal-policy.updateSharePolicy': tuple(bool, workspace),
  'personal-policy.getSubscriptionShare': inWorkspace,
  'personal-policy.updateSubscriptionShare': tuple(object({ shared: bool, allowOthers: bool.optional() }), workspace),
  'personal-policy.getCreditShare': inWorkspace,
  'personal-policy.updateCreditShare': tuple(bool, workspace),
  'personal-policy.getPaymentDesignation': inWorkspace,
  'personal-policy.updatePaymentDesignation': tuple(bool, workspace),
  'preferences.getPreferences': none,
  'preferences.updatePreferences': tuple(preferences),
  'projects.listProjects': tuple(),
  'projects.listWorkspaceProjects': tuple(uuid),
  'projects.saveProject': tuple(projectInput),
  'projects.updateProjectProperties': tuple(projectPatch.extend({ workspaceId: uuid.optional() })),
  'projects.moveIssueToProject': tuple(object({ issueId: uuid, revision: positive, projectId: uuid.nullable(), workspaceId: uuid.optional(), confirmAccess: bool.optional() })),
  'projects.listProjectEvents': tuple(uuid, uuid.optional()),
  'projects.setProjectIssues': tuple(object({ id: uuid, revision: positive, issueIds: z.array(uuid), workspaceId: uuid.optional(), confirmAccess: bool.optional() })),
  'projects.getProjectLifecycleImpact': tuple(object({ id: uuid, workspaceId: uuid.optional() })),
  'projects.archiveProject': tuple(object({ id: uuid, revision: positive.optional(), workspaceId: uuid.optional() })),
  'projects.restoreProject': tuple(object({ id: uuid, revision: positive.optional(), workspaceId: uuid.optional() })),
  'projects.deleteProject': tuple(object({ id: uuid, revision: positive, confirmation: text(200), workspaceId: uuid.optional() })),
  'settings-activity.listSavedLogins': none,
  'settings-activity.deleteSavedLogin': oneId,
  'settings-activity.saveSavedLogin': tuple(object({ site: text(2048).min(1), account: text(4096).min(1).regex(/^[^\r\n\0]+$/), password: text(4096).min(1).regex(/^[^\r\n\0]+$/) })),
  'settings-activity.replaceSavedLoginPassword': tuple(uuid, text(4096).min(1).regex(/^[^\r\n\0]+$/)),
  'settings-activity.listSavedLoginUsage': oneId,
  'task-runs.pollTaskRuns': none,
  'task-runs.pollThreads': tuple(version.optional(), listPositions(200).optional()),
  'task-runs.syncThreadList': tuple(version.optional(), listPositions(200).optional()),
  'team-relations.getIssueTeam': oneId,
  'team-relations.setIssueTeam': tuple(object({ issueId: uuid, teamId: uuid.nullable(), expectedTeamId: uuid.nullable() })),
  'team-relations.listProjectTeams': none,
  'team-relations.setProjectTeams': tuple(object({ projectId: uuid, revision: positive, teamIds: z.array(uuid).max(100), primaryTeamId: uuid.nullable() })),
  'teams.listTeams': none,
  'teams.loadTeamDirectory': inWorkspace,
  'teams.saveTeam': tuple(object({ id: uuid.optional(), workspaceId: uuid, name: text(120).trim().min(1), identifier: text(20).min(1), description: text(2000) })),
  'teams.listTeamMembers': tuple(uuid, workspace),
  'teams.changeTeamMember': tuple(object({ teamId: uuid, userId: id.optional(), action: z.enum(['join', 'leave', 'add', 'remove', 'owner', 'member']) })),
  // 删除团队: the server checks the workspace admin and that the typed name equals the team's (app/actions/teams.ts).
  'teams.getTeamDeletionImpact': tuple(uuid),
  'teams.deleteTeam': tuple(uuid, text(120)),
  'telegram.getTelegramIntegrationStatus': none,
  'telegram.createTelegramConnectLink': none,
  'telegram.disconnectTelegram': none,
  'tokens.listAccessTokens': inWorkspace,
  'tokens.createAccessToken': tuple(object({ name: text(200).trim().min(1), expiresAt: z.iso.datetime().nullish() }), workspace),
  'tokens.revokeAccessToken': tuple(object({ id: uuid }), workspace),
  'usage.getUsage': tuple(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), workspace),
  'user-secrets.listMySecrets': inWorkspace,
  'user-secrets.createMySecret': tuple(object({ ...secretBase, overrideWorkspace: bool.optional() }), workspace),
  'user-secrets.replaceMySecret': tuple(object({ id: uuid, value: secret.optional(), note: text(2000).optional() }), workspace),
  'user-secrets.deleteMySecret': tuple(object({ id: uuid }), workspace),
  'user-secrets.importMySecrets': tuple(object({ ...importBase, overrideWorkspace: bool.optional() }), workspace),
  'workspace-secrets.listSecrets': inWorkspace,
  'workspace-secrets.getE2BKeyCapability': inWorkspace,
  'workspace-secrets.createSecret': tuple(object({ ...secretBase, scope: scope.optional() }), workspace),
  'workspace-secrets.replaceSecret': tuple(object({ id: uuid, value: secret.optional(), note: text(2000).optional(), scope: scope.optional() }), workspace),
  'workspace-secrets.importSecrets': tuple(object({ ...importBase, scope }), workspace),
  'workspace-secrets.deleteSecret': tuple(object({ id: uuid }), workspace),
  'workspace-secrets.saveE2BKey': tuple(object({ apiKey: text(1024).min(1) }), workspace),
  'workspace-secrets.deleteE2BKey': inWorkspace,
  'workspace-settings.getWorkspaceGeneral': inWorkspace,
  'workspace-settings.getWorkspaceDeletionImpact': inWorkspace,
  'workspace-settings.getWorkspaceTransferTargets': inWorkspace,
  'workspace-settings.listArchivedBots': inWorkspace,
  'workspace-settings.updateWorkspace': tuple(object({ name: text(120).trim().min(1).optional(), slug: slug.optional(), icon: text(400_000).nullish() }), workspace),
  'workspace-settings.transferWorkspace': tuple(id, workspace),
  'workspace-settings.deleteWorkspace': tuple(uuid, text(120).min(1)),
  'workspace-settings.takeOverArchivedBot': tuple(uuid, workspace),
  'workspace.createWorkspace': tuple(z.union([text(120).trim().min(1), object({ name: text(120).trim().min(1), slug })])),
  'workspace.switchWorkspace': tuple(z.union([uuid, object({ workspaceId: workspace, accountId: id.optional() })])),
  'workspace.createWorkspaceInvitation': tuple(object({ workspaceId: uuid, emails: z.array(z.email().max(254)).min(1).max(20), role: z.enum(['admin', 'member']) })),
  'workspace.updateWorkspaceMember': tuple(object({ workspaceId: uuid, userId: id, role: z.enum(['admin', 'member']), status: z.enum(['active', 'suspended']), transferTo: id.optional() })),
  'workspace.revokeWorkspaceInvitation': tuple(uuid, uuid),
  'workspace.acceptWorkspaceInvitation': tuple(z.string().regex(/^[a-f0-9]{64}$/)),
} satisfies Record<string, z.ZodType>

export type DesktopActionName = keyof typeof desktopActionSchemas
