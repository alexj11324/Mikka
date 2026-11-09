import 'server-only'
import type { Pool } from 'pg'
import { retryEnterpriseDirectoryOutbox } from './lifecycle'
import { retryMemberLifecycleOutbox } from '../governance/member-outbox'
import { retryOrganizationPolicyOutbox } from '../governance/resource-policy'
import { sweepOrganizationAuditRetention } from '../governance/audit-export'
import { deliverIdentityAudits } from './audit-outbox'
import { drainLiveRevocations } from './live-authority'
import { liveGatewayConfig } from '../live/scope'

/** Reuses the existing durable audit-maintenance timer; this is not a periodic polling loop. */
export async function maintainEnterpriseGovernance() {
  const live = await drainLiveRevocations({}, false)
  const directories = await retryEnterpriseDirectoryOutbox(undefined, false)
  const identityAudits = await deliverIdentityAudits(undefined, false)
  const members = await retryMemberLifecycleOutbox()
  const policies = await retryOrganizationPolicyOutbox()
  const retention = await sweepOrganizationAuditRetention()
  return { live, directories, identityAudits, members, policies, retention }
}

export async function nextEnterpriseMaintenanceDue(main: Pick<Pool, 'query'>, workspace: Pick<Pool, 'query'>): Promise<number | null> {
  const [identity, governance] = await Promise.all([
    main.query<{ at: string | null }>(`select ceil(extract(epoch from min(at))*1000)::bigint::text as at from (
      select coalesce("lastAttemptAt"+interval '30 seconds',"createdAt") as at from enterprise_scim_outbox where "deliveredAt" is null
      union all select coalesce("lastAttemptAt"+interval '30 seconds',"createdAt") from enterprise_audit_outbox where "deliveredAt" is null
      union all select coalesce("lastAttemptAt"+interval '30 seconds',"createdAt") from enterprise_live_capabilities
        where "revokedAt" is not null and "deliveredAt" is null and $1) pending`, [!!liveGatewayConfig(process.env)]),
    workspace.query<{ at: string | null }>(`select ceil(extract(epoch from min(at))*1000)::bigint::text as at from (
      select "createdAt" as at from mikka_governance_member_outbox where "deliveredAt" is null
      union all select "createdAt" from mikka_organization_policy_outbox where "deliveredAt" is null
      union all select e."expiresAt" from mikka_organization_audit_exports e left join mikka_organization_resource_policies p on p."organizationId"=e."organizationId" where not coalesce(p."legalHold",false)
      union all select date_trunc('hour',a.oldest+make_interval(days=>p."auditRetentionDays"),'UTC')+interval '1 hour'
        from mikka_organization_resource_policies p cross join lateral (select min("createdAt") as oldest from mikka_organization_audit_events where "organizationId"=p."organizationId") a
        where p."auditRetentionDays" is not null and not p."legalHold" and a.oldest is not null
          and not exists(select 1 from mikka_organization_audit_exports e where e."organizationId"=p."organizationId" and e."expiresAt">now())) pending`),
  ])
  const times = [identity.rows[0]?.at, governance.rows[0]?.at].filter((value): value is string => value != null).map(Number)
  return times.length ? Math.min(...times) : null
}
