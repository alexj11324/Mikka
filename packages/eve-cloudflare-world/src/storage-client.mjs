import {
  EntityConflictError, HookConflictError, HookNotFoundError,
  RunExpiredError, TooEarlyError, WorkflowRunNotFoundError, WorkflowWorldError,
} from '@workflow/errors'

function filterStep(step, options) {
  return options?.resolveData === 'none' ? { ...step, input: undefined, output: undefined } : step
}

function requireRun(run, runId) {
  if (!run) throw new WorkflowRunNotFoundError(runId)
  return run
}

function requireHook(hook, id) {
  if (!hook) throw new HookNotFoundError(id)
  return hook
}

/** Errors are reconstructed on the client because workerd RPC does not
 * preserve custom Error prototypes across the Node/Worker boundary. */
export function createAdmissionStorage(authority) {
  return {
    runs: { get: async id => requireRun(await authority.run(id), id) },
    steps: {
      async get(runId, stepId, options) {
        const step = await authority.step(runId, stepId)
        if (!step) throw new WorkflowWorldError('Workflow step not found', { status: 404 })
        return filterStep(step, options)
      },
      async list({ runId, pagination, resolveData }) {
        const page = await authority.steps(runId, pagination)
        return { ...page, data: page.data.map(step => filterStep(step, { resolveData })) }
      },
    },
    hooks: {
      get: async id => requireHook(await authority.hook(id), id),
      getByToken: async token => requireHook(await authority.hookByToken(token), token),
    },
    events: {
      async create(runId, request) {
        const result = await authority.create(runId, request)
        if (result.ok) {
          const { ok, replayed, ...receipt } = result
          return receipt
        }
        switch (result.code) {
          case 'HOOK_CONFLICT': throw new HookConflictError(result.token, result.conflictingRunId)
          case 'RUN_NOT_FOUND': throw new WorkflowRunNotFoundError(runId)
          case 'HOOK_NOT_FOUND': throw new HookNotFoundError(request.correlationId)
          case 'ENTITY_CONFLICT': throw new EntityConflictError('Workflow entity already exists')
          case 'TOO_EARLY': throw new TooEarlyError('Workflow step retry is not due', { retryAfter: result.retryAfter })
          case 'RUN_EXPIRED': throw new RunExpiredError('Workflow run has ended')
          default: throw new WorkflowWorldError('Cloudflare World rejected the event', {
            status: result.status, code: result.code, reason: result.reason,
          })
        }
      },
      list: ({ runId, pagination }) => authority.events(runId, pagination),
    },
  }
}

// Applies to the admission storage only. A deployable World must also qualify
// the queue, complete event storage and streamer before application startup.
export const admissionCapabilities = { atomicStartHook: { active: true } }
