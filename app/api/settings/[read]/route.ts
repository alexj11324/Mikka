import { NextResponse } from 'next/server'
import { withRequestLog } from '@/lib/request-log'
import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { getPasswordStatus, listSessions } from '@/app/actions/account'
import { getPreferences } from '@/app/actions/preferences'
import { getIssuePrefixState } from '@/app/actions/issue-prefix'
import { cacheReadAction } from '@/lib/cache-read-action'
import { listSavedLogins } from '@/app/actions/settings-activity'
import { getWorkspaceDeletionImpact, getWorkspaceGeneral, getWorkspaceTransferTargets } from '@/app/actions/workspace-settings'
import { getAppPolicy } from '@/app/actions/app-policy'
import { getSharePolicy } from '@/app/actions/personal-policy'
import { getE2BKeyCapability, listSecrets } from '@/app/actions/workspace-secrets'
import { getUsage } from '@/app/actions/usage'
import { cardVerificationStatus, getBilling, getCreditBilling } from '@/app/actions/billing'
import { listAuditLog } from '@/app/actions/audit-log'
import { getModelOrder } from '@/app/actions/model-order'
import { listBots, listWorkspaceBots } from '@/app/actions/bots'
import { getApiKeys } from '@/app/actions/model-api-keys'
import type { AuditFilter } from '@/lib/audit/cursor'
import type { SettingsRead } from '@/lib/settings-read'

/**
 * Settings' first reads as GETs. They call the same functions the sections
 * used to call as server actions, with the same session and workspace/admin
 * checks inside, and return the same bodies. A GET never waits in Next's
 * one-at-a-time server-action queue, so reading never delays a save.
 */
const READS: Record<SettingsRead, (query: URLSearchParams) => Promise<unknown>> = {
  password: () => getPasswordStatus(),
  sessions: () => listSessions(),
  preferences: () => getPreferences(),
  'issue-prefix': () => getIssuePrefixState(),
  'saved-logins': () => listSavedLogins(),
  'workspace-general': query => getWorkspaceGeneral(workspace(query)),
  'transfer-targets': query => getWorkspaceTransferTargets(workspace(query)),
  'deletion-impact': query => getWorkspaceDeletionImpact(workspace(query)),
  'app-policy': query => getAppPolicy(workspace(query)),
  'share-policy': query => getSharePolicy(workspace(query)),
  secrets: query => listSecrets(workspace(query)),
  // The E2B row needs canEdit as well as the key's state.
  'e2b-key': query => getE2BKeyCapability(workspace(query)),
  usage: query => getUsage(query.get('month') ?? undefined, workspace(query)),
  billing: query => getBilling(workspace(query)),
  'credit-billing': query => getCreditBilling(workspace(query)),
  'card-verification': query => cardVerificationStatus(workspace(query)),
  // listWorkspaceAudit validates the filter and cursor.
  // 模型与订阅: the allowed models in order and 运行位置 (decision 2026-11-02-1400).
  'model-order': query => getModelOrder(workspace(query)),
  bots: () => listBots(),
  'workspace-bots': () => listWorkspaceBots(),
  'api-keys': query => getApiKeys(workspace(query)),
  audit: query => listAuditLog({ filter: (query.get('filter') ?? undefined) as AuditFilter | undefined, cursor: query.get('cursor') }, workspace(query)),
}

function workspace(query: URLSearchParams) {
  return query.get('workspace') ?? undefined
}

async function handleGET(request: Request, { params }: { params: Promise<{ read: string }> }) {
  const { read } = await params
  if (!Object.hasOwn(READS, read)) return NextResponse.json({ error: 'notFound' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
  const body = await cacheReadAction(() => withDatabaseOperation(`/api/settings/${read}`, () => READS[read as SettingsRead](new URL(request.url).searchParams)))
  const code = body && typeof body === 'object' && 'error' in body ? body.error : undefined
  const status = code === 'authRequired' ? 401 : code === 'workspaceAccessDenied' || code === 'workspaceMembershipSuspended' ? 403 : 200
  return NextResponse.json(body ?? null, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

export const GET = withRequestLog('/api/settings/[read]', handleGET)
