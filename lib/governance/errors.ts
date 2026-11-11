import { CodedError } from '@mikka/protocol/coded-error'

export type GovernanceErrorDetail = 'access_denied' | 'seat_limit' | 'feature_unavailable' | 'last_owner' | 'workspace_attached' | 'billing_account_attached' | 'personal_workspace' | 'invalid_request' | 'template_limit' | 'not_found' | 'plan_changed'
export class GovernanceError extends CodedError<'governance_denied', GovernanceErrorDetail> {
  constructor(detail: GovernanceErrorDetail, cause?: unknown) {
    super('governance_denied', { detail, ...(cause === undefined ? {} : { cause }) })
    this.name = 'GovernanceError'
  }
}
