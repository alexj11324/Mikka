import * as enabledModels from '@/app/actions/enabled-models'
import 'server-only'
import { desktopActionSchemas, type DesktopActionName } from './schemas'
import { desktopBootstrap, desktopSession, desktopAccounts, desktopWorkspaceLink } from './bootstrap'
import type { DesktopActions } from './handler'
import { createReadBatch } from './read-batch'
import * as actions0 from '@/app/actions/account'
import * as actions1 from '@/app/actions/agents'
import * as actions2 from '@/app/actions/app-policy'
import * as actions3 from '@/app/actions/artifacts'
import * as actions4 from '@/app/actions/audit-log'
import * as actions5 from '@/app/actions/billing'
import * as actions6 from '@/app/actions/bots'
import * as actions7 from '@/app/actions/collaboration'
import * as actions8 from '@/app/actions/coordinator'
import * as actions9 from '@/app/actions/desktop-notifications'
import * as actions10 from '@/app/actions/execution-settings'
import * as actions11 from '@/app/actions/issue-metadata'
import * as actions12 from '@/app/actions/issue-operations'
import * as actions13 from '@/app/actions/issue-prefix'
import * as actions14 from '@/app/actions/issues'
import * as actions15 from '@/app/actions/linear-sync'
import * as actions16 from '@/app/actions/link-preview'
import * as actions17 from '@/app/actions/memory'
import * as actions18 from '@/app/actions/model-api-keys'
import * as actions19 from '@/app/actions/model-order'
import * as actions20 from '@/app/actions/onboarding'
import * as actions21 from '@/app/actions/pending-actions'
import * as actions22 from '@/app/actions/personal-policy'
import * as actions23 from '@/app/actions/preferences'
import * as actions24 from '@/app/actions/projects'
import * as actions25 from '@/app/actions/settings-activity'
import * as actions26 from '@/app/actions/task-runs'
import * as actions27 from '@/app/actions/team-relations'
import * as actions28 from '@/app/actions/teams'
import * as actions29 from '@/app/actions/telegram'
import * as actions30 from '@/app/actions/tokens'
import * as actions31 from '@/app/actions/usage'
import * as actions32 from '@/app/actions/user-secrets'
import * as actions33 from '@/app/actions/workspace'
import * as actions34 from '@/app/actions/workspace-secrets'
import * as actions35 from '@/app/actions/workspace-settings'
import * as actions36 from '@/app/actions/environments'

// This literal is the complete callable surface, independent of Next build IDs.
const functions = {
  'desktop.readBatch': createReadBatch(() => desktopActions),
  'desktop.bootstrap': desktopBootstrap,
  'desktop.session': desktopSession,
  'desktop.accounts': desktopAccounts,
  'desktop.workspaceLink': desktopWorkspaceLink,
  'environments.saveEnvironment': actions36.saveEnvironment,
  'environments.archiveEnvironment': actions36.archiveEnvironment,
  'account.updateDisplayName': actions0.updateDisplayName,
  'account.uploadAvatar': actions0.uploadAvatar,
  'account.getPasswordStatus': actions0.getPasswordStatus,
  'account.listSessions': actions0.listSessions,
  'account.listSharedLinks': actions0.listSharedLinks,
  'account.changePassword': actions0.changePassword,
  'account.setPassword': actions0.setPassword,
  'account.revokeSession': actions0.revokeSession,
  'account.revokeOtherSessions': actions0.revokeOtherSessions,
  'account.requestDataExport': actions0.requestDataExport,
  'account.deleteAccount': actions0.deleteAccount,
  'agents.listDevices': actions1.listDevices,
  'agents.pollDevices': actions1.pollDevices,
  'agents.setDeviceEnabled': actions1.setDeviceEnabled,
  'agents.renameDevice': actions1.renameDevice,
  'agents.removeDevice': actions1.removeDevice,
  'agents.listAgents': actions1.listAgents,
  'agents.pollIssueThreads': actions1.pollIssueThreads,
  'agents.findThreadIssue': actions1.findThreadIssue,
  'agents.getIssueThread': actions1.getIssueThread,
  'agents.getThreadChanges': actions1.getThreadChanges,
  'agents.getThreadMachine': actions1.getThreadMachine,
  'agents.getThreadInstructions': actions1.getThreadInstructions,
  'agents.sendIssueThreadReply': actions1.sendIssueThreadReply,
  'agents.getThreadName': actions1.getThreadName,
  'agents.stopRun': actions1.stopRun,
  'agents.resumeQuotaPausedRunOnApiKey': actions1.resumeQuotaPausedRunOnApiKey,
  'agents.retryQuotaPausedRun': actions1.retryQuotaPausedRun,
  'agents.sendDeviceCommand': actions1.sendDeviceCommand,
  'app-policy.getAppPolicy': actions2.getAppPolicy,
  'app-policy.updateAppPolicy': actions2.updateAppPolicy,
  'artifacts.listArtifacts': actions3.listArtifacts,
  'artifacts.listRunArtifacts': actions3.listRunArtifacts,
  'artifacts.getArtifact': actions3.getArtifact,
  'artifacts.getArtifactText': actions3.getArtifactText,
  'artifacts.shareArtifact': actions3.shareArtifact,
  'artifacts.stopSharingArtifact': actions3.stopSharingArtifact,
  'audit-log.listAuditLog': actions4.listAuditLog,
  'billing.getBilling': actions5.getBilling,
  'billing.getCreditBilling': actions5.getCreditBilling,
  'billing.cardVerificationStatus': actions5.cardVerificationStatus,
  'billing.getHostedUsage': actions5.getHostedUsage,
  'billing.openBillingPortal': actions5.openBillingPortal,
  'billing.startPlanCheckout': actions5.startPlanCheckout,
  'billing.startPointsPurchase': actions5.startPointsPurchase,
  'billing.startChatPointsPurchase': actions5.startChatPointsPurchase,
  'billing.startCardVerification': actions5.startCardVerification,
  'bots.listBots': actions6.listBots,
  'bots.pollBots': actions6.pollBots,
  'bots.createBot': actions6.createBot,
  'bots.updateBot': actions6.updateBot,
  'bots.listWorkspaceBots': actions6.listWorkspaceBots,
  'collaboration.exchangeDocument': actions7.exchangeDocument,
  'collaboration.listMembers': actions7.listMembers,
  'collaboration.inviteMember': actions7.inviteMember,
  'collaboration.removeMember': actions7.removeMember,
  'coordinator.pollCoordinatorChat': actions8.pollCoordinatorChat,
  'coordinator.syncCoordinatorChat': actions8.syncCoordinatorChat,
  'coordinator.coordinatorHistory': actions8.coordinatorHistory,
  'coordinator.coordinatorCitationSources': actions8.coordinatorCitationSources,
  'coordinator.coordinatorReasoning': actions8.coordinatorReasoning,
  'coordinator.pollBotChatSummaries': actions8.pollBotChatSummaries,
  'coordinator.sendCoordinatorMessage': actions8.sendCoordinatorMessage,
  'coordinator.welcomeCoordinator': actions8.welcomeCoordinator,
  'coordinator.stopCoordinatorTurn': actions8.stopCoordinatorTurn,
  'coordinator.retryCoordinatorTurn': actions8.retryCoordinatorTurn,
  'coordinator.sendSuggestion': actions8.sendSuggestion,
  'coordinator.issueCreationAvailable': actions8.issueCreationAvailable,
  'desktop-notifications.chooseDesktopNotifications': actions9.chooseDesktopNotifications,
  'execution-settings.getBotModelMenu': actions10.getBotModelMenu,
  'execution-settings.refreshBotModelMenuAction': actions10.refreshBotModelMenuAction,
  'execution-settings.chooseBotModel': actions10.chooseBotModel,
  'issue-metadata.getIssuePropertyOptions': actions11.getIssuePropertyOptions,
  'issue-metadata.updateIssueMetadata': actions11.updateIssueMetadata,
  'issue-operations.listIssueConnections': actions12.listIssueConnections,
  'issue-operations.updateIssueRelation': actions12.updateIssueRelation,
  'issue-operations.createLinkedIssue': actions12.createLinkedIssue,
  'issue-operations.toggleIssuePreference': actions12.toggleIssuePreference,
  'issue-operations.getDeletedIssue': actions12.getDeletedIssue,
  'issue-operations.setIssueDeleted': actions12.setIssueDeleted,
  'issue-prefix.getIssuePrefixState': actions13.getIssuePrefixState,
  'issue-prefix.saveIssuePrefix': actions13.saveIssuePrefix,
  'issues.listIssues': actions14.listIssues,
  'issues.pollIssues': actions14.pollIssues,
  'issues.syncIssueList': actions14.syncIssueList,
  'issues.listWorkspaceIssues': actions14.listWorkspaceIssues,
  'issues.getIssue': actions14.getIssue,
  'issues.pollIssue': actions14.pollIssue,
  'issues.saveIssue': actions14.saveIssue,
  'issues.promoteIssueToTeam': actions14.promoteIssueToTeam,
  'issues.moveIssue': actions14.moveIssue,
  'issues.changeIssuePriority': actions14.changeIssuePriority,
  'issues.listIssueVersions': actions14.listIssueVersions,
  'issues.pollIssueVersionSummaries': actions14.pollIssueVersionSummaries,
  'issues.setIssueScope': actions14.setIssueScope,
  'linear-sync.getLinearIntegrationState': actions15.getLinearIntegrationState,
  'linear-sync.getLinearBoardSync': actions15.getLinearBoardSync,
  'linear-sync.startLinearOAuth': actions15.startLinearOAuth,
  'linear-sync.listLinearTeamOptions': actions15.listLinearTeamOptions,
  'linear-sync.enableLinearTeam': actions15.enableLinearTeam,
  'linear-sync.disableLinearTeam': actions15.disableLinearTeam,
  'linear-sync.retryLinearIssue': actions15.retryLinearIssue,
  'linear-sync.retryLinearDelivery': actions15.retryLinearDelivery,
  'linear-sync.disconnectLinearAccount': actions15.disconnectLinearAccount,
  'link-preview.getLinkPreview': actions16.getLinkPreview,
  'memory.getMemory': actions17.getMemory,
  'memory.setMemory': actions17.setMemory,
  'memory.removeFact': actions17.removeFact,
  'memory.updateFact': actions17.updateFact,
  'model-api-keys.getApiKeys': actions18.getApiKeys,
  'model-api-keys.refetchApiKeyModels': actions18.refetchApiKeyModels,
  'model-api-keys.updateApiKeyAfterQuota': actions18.updateApiKeyAfterQuota,
  'model-api-keys.createApiKey': actions18.createApiKey,
  'model-api-keys.deleteApiKey': actions18.deleteApiKey,
  'model-api-keys.updateApiKeyShare': actions18.updateApiKeyShare,
  'enabled-models.getEnabledModels': enabledModels.getEnabledModels,
  'enabled-models.setModelEnabled': enabledModels.setModelEnabled,
  'enabled-models.setAllModelsEnabled': enabledModels.setAllModelsEnabled,
  'enabled-models.setAutoEnable': enabledModels.setAutoEnable,
  'enabled-models.markModelsSeen': enabledModels.markModelsSeen,
  'model-order.getModelOrder': actions19.getModelOrder,
  'model-order.checkModelOrderQuota': actions19.checkModelOrderQuota,
  'model-order.refreshSubscriptionModels': actions19.refreshSubscriptionModels,
  'model-order.changeModelOrder': actions19.changeModelOrder,
  'onboarding.completeOnboarding': actions20.completeOnboarding,
  'onboarding.resetOnboarding': actions20.resetOnboarding,
  'pending-actions.decidePendingAction': actions21.decidePendingAction,
  'personal-policy.getSharePolicy': actions22.getSharePolicy,
  'personal-policy.updateSharePolicy': actions22.updateSharePolicy,
  'personal-policy.getSubscriptionShare': actions22.getSubscriptionShare,
  'personal-policy.updateSubscriptionShare': actions22.updateSubscriptionShare,
  'personal-policy.getCreditShare': actions22.getCreditShare,
  'personal-policy.updateCreditShare': actions22.updateCreditShare,
  'personal-policy.getPaymentDesignation': actions22.getPaymentDesignation,
  'personal-policy.updatePaymentDesignation': actions22.updatePaymentDesignation,
  'preferences.getPreferences': actions23.getPreferences,
  'preferences.updatePreferences': actions23.updatePreferences,
  'projects.listProjects': actions24.listProjects,
  'projects.saveProject': actions24.saveProject,
  'projects.updateProjectProperties': actions24.updateProjectProperties,
  'projects.moveIssueToProject': actions24.moveIssueToProject,
  'projects.listProjectEvents': actions24.listProjectEvents,
  'projects.setProjectIssues': actions24.setProjectIssues,
  'settings-activity.listSavedLogins': actions25.listSavedLogins,
  'settings-activity.deleteSavedLogin': actions25.deleteSavedLogin,
  'settings-activity.saveSavedLogin': actions25.saveSavedLogin,
  'settings-activity.replaceSavedLoginPassword': actions25.replaceSavedLoginPassword,
  'settings-activity.listSavedLoginUsage': actions25.listSavedLoginUsage,
  'task-runs.pollTaskRuns': actions26.pollTaskRuns,
  'task-runs.pollThreads': actions26.pollThreads,
  'task-runs.syncThreadList': actions26.syncThreadList,
  'team-relations.getIssueTeam': actions27.getIssueTeam,
  'team-relations.setIssueTeam': actions27.setIssueTeam,
  'team-relations.listProjectTeams': actions27.listProjectTeams,
  'team-relations.setProjectTeams': actions27.setProjectTeams,
  'teams.listTeams': actions28.listTeams,
  'teams.loadTeamDirectory': actions28.loadTeamDirectory,
  'teams.saveTeam': actions28.saveTeam,
  'teams.listTeamMembers': actions28.listTeamMembers,
  'teams.changeTeamMember': actions28.changeTeamMember,
  'teams.getTeamDeletionImpact': actions28.getTeamDeletionImpact,
  'teams.deleteTeam': actions28.deleteTeam,
  'telegram.getTelegramIntegrationStatus': actions29.getTelegramIntegrationStatus,
  'telegram.createTelegramConnectLink': actions29.createTelegramConnectLink,
  'telegram.disconnectTelegram': actions29.disconnectTelegram,
  'tokens.listAccessTokens': actions30.listAccessTokens,
  'tokens.createAccessToken': actions30.createAccessToken,
  'tokens.revokeAccessToken': actions30.revokeAccessToken,
  'usage.getUsage': actions31.getUsage,
  'user-secrets.listMySecrets': actions32.listMySecrets,
  'user-secrets.createMySecret': actions32.createMySecret,
  'user-secrets.replaceMySecret': actions32.replaceMySecret,
  'user-secrets.deleteMySecret': actions32.deleteMySecret,
  'user-secrets.importMySecrets': actions32.importMySecrets,
  'workspace-secrets.listSecrets': actions34.listSecrets,
  'workspace-secrets.getE2BKeyCapability': actions34.getE2BKeyCapability,
  'workspace-secrets.createSecret': actions34.createSecret,
  'workspace-secrets.replaceSecret': actions34.replaceSecret,
  'workspace-secrets.importSecrets': actions34.importSecrets,
  'workspace-secrets.deleteSecret': actions34.deleteSecret,
  'workspace-secrets.saveE2BKey': actions34.saveE2BKey,
  'workspace-secrets.deleteE2BKey': actions34.deleteE2BKey,
  'workspace-settings.getWorkspaceGeneral': actions35.getWorkspaceGeneral,
  'workspace-settings.getWorkspaceDeletionImpact': actions35.getWorkspaceDeletionImpact,
  'workspace-settings.getWorkspaceTransferTargets': actions35.getWorkspaceTransferTargets,
  'workspace-settings.listArchivedBots': actions35.listArchivedBots,
  'workspace-settings.updateWorkspace': actions35.updateWorkspace,
  'workspace-settings.transferWorkspace': actions35.transferWorkspace,
  'workspace-settings.deleteWorkspace': actions35.deleteWorkspace,
  'workspace-settings.takeOverArchivedBot': actions35.takeOverArchivedBot,
  'workspace.createWorkspace': actions33.createWorkspace,
  'workspace.switchWorkspace': actions33.switchWorkspace,
  'workspace.createWorkspaceInvitation': actions33.createWorkspaceInvitation,
  'workspace.updateWorkspaceMember': actions33.updateWorkspaceMember,
  'workspace.revokeWorkspaceInvitation': actions33.revokeWorkspaceInvitation,
  'workspace.acceptWorkspaceInvitation': actions33.acceptWorkspaceInvitation,
} satisfies Record<DesktopActionName, (...args: never[]) => Promise<unknown>>

export const desktopActions: DesktopActions = Object.fromEntries(
  (Object.keys(functions) as DesktopActionName[]).map(name => [name, {
    args: desktopActionSchemas[name],
    invoke: (args: never[]) => (functions[name] as (...input: never[]) => Promise<unknown>)(...args),
  }]),
)
