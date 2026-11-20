const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const workflowId = /^wrun_[A-Za-z0-9_-]{1,123}$/
const stepId = /^step_[A-Za-z0-9_-]{1,123}$/
const prefix = 'mikka-hosted:'

/** A LiteLLM call ID, not a provider completion/generation ID. */
export function decodeHostedCallId(value) {
  if (typeof value !== 'string' || value.length > 200 || !value.startsWith(prefix)) return null
  const [usageId, workflowRunId, step, attempt, ...extra] = value.slice(prefix.length).split(':')
  if (!uuid.test(usageId) || extra.length) return null
  if (workflowRunId === undefined && step === undefined && attempt === undefined) return { usageId }
  if (!workflowId.test(workflowRunId ?? '') || !stepId.test(step ?? '')
    || !/^(?:0|[1-9][0-9]{0,6})$/.test(attempt ?? '') || Number(attempt) > 1_000_000) return null
  return { usageId, workflowRunId, stepId: step, attempt: Number(attempt) }
}

/** Construct only from the actual reservation and the server's Workflow metadata. */
export function hostedCallId(usageId, identity = {}) {
  const fields = [identity.workflowRunId, identity.stepId, identity.attempt]
  const value = prefix + usageId + (fields.every(field => field === undefined) ? '' : ':' + fields.join(':'))
  if (!decodeHostedCallId(value)) throw new Error('hosted_call_identity_invalid')
  return value
}
