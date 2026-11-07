import 'server-only'
import { governanceSession } from '../governance/http'
import { requireEnterpriseOrganization } from './access'
import { pool } from '../db'
import { z } from 'zod'
import { GovernanceError } from '../governance/errors'

export async function organizationAccountSession(request: Request) {
  if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('origin') !== new URL(request.url).origin) throw new GovernanceError('access_denied')
  const session = await governanceSession(request)
  const { rows } = await pool.query('select 1 from session where id=$1 and "userId"=$2 and "expiresAt">now()', [session.session.id, session.user.id])
  if (!rows.length) throw new GovernanceError('access_denied')
  return session
}

/** Organization administration must satisfy the same authentication policy as its workspaces. */
export async function organizationSession(request: Request, organizationId: string, allowArchiveRetry = false) {
  z.uuid().parse(organizationId)
  const session = await organizationAccountSession(request)
  if (allowArchiveRetry) {
    const { rows } = await pool.query('select 1 from enterprise_org_policy where "organizationId"=$1 and "archivedAt" is not null', [organizationId])
    // The endpoint still requires the persisted owner role. This can only finish an already committed archive barrier.
    if (rows.length) return session
  }
  await requireEnterpriseOrganization(session.user.id, organizationId, session.session.id)
  return session
}
