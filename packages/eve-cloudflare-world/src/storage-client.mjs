import { filterRun } from './records.mjs'
import {
  EntityConflictError, HookConflictError, HookNotFoundError,
  RunExpiredError, TooEarlyError, WorkflowRunNotFoundError, WorkflowWorldError,
} from '@workflow/errors'
import { eventIdToSlot, stripEventDataRefs } from '@workflow/world'
import { monotonicFactory } from 'ulid'

const mintId = monotonicFactory()

function filterStep(step, options) {
  return options?.resolveData === 'none' ? { ...step, input: undefined, output: undefined } : step
}

function filterHook(hook, options) {
  if (options?.resolveData !== 'none') return hook
  const { metadata, ...rest } = hook
  return rest
}

function requireRun(run, runId, options) {
  if (!run) throw new WorkflowRunNotFoundError(runId)
  // Node and Worker releases roll independently; an older Worker can still return a full run.
  return filterRun(run, options?.resolveData)
}

function requireHook(hook, id, options) {
  if (!hook) throw new HookNotFoundError(id)
  return filterHook(hook, options)
}

async function page(promise, fn) {
  const result = await promise
  return { ...result, data: result.data.map(fn) }
}

/** Reconstruct upstream error classes at the Node boundary. Worker RPC
 * preserves the result and typed payload bytes, not remote Error prototypes. */
export function createAdmissionStorage(authority) {
  return {
    runs: {
      get: async (id, options) => requireRun(await authority.run(id, options?.resolveData), id, options),
      list: (options = {}) => page(authority.runs(options), run => filterRun(run, options.resolveData)),
      ...(authority.waitTerminal ? { waitForTerminalStatus: async (id, options) =>
        requireRun(await authority.waitTerminal(id, options), id, options) } : {}),
    },
    steps: {
      async get(runId, stepId, options) {
        const step = await authority.step(runId, stepId)
        if (!step) throw new WorkflowWorldError('Workflow step not found', { status: 404 })
        return filterStep(step, options)
      },
      list: ({ runId, pagination, resolveData }) =>
        page(authority.steps(runId, pagination), step => filterStep(step, { resolveData })),
    },
    hooks: {
      get: async (id, options) => requireHook(await authority.hook(id), id, options),
      getByToken: async (token, options) => requireHook(await authority.hookByToken(token), token, options),
      list: (options = {}) => page(authority.hooks(options), hook => filterHook(hook, options)),
    },
    events: {
      async create(runId, request, options = {}) {
        if (runId === null && request.eventType === 'run_created') runId = 'wrun_' + mintId()
        // The official SDK's replay observer is a synchronous Node callback.
        // Only serializable options cross the Worker/DO transport.
        const { replayEventObserver, ...params } = options
        const result = await authority.create(runId, request, params)
        if (result.ok) {
          const { ok, replayed, ...receipt } = result
          if (receipt.events) {
            receipt.events = receipt.events.map(event => stripEventDataRefs(event, options.resolveData ?? 'all'))
            if (replayEventObserver) for (const event of receipt.events) replayEventObserver(event)
          }
          if (receipt.event) receipt.event = stripEventDataRefs(receipt.event, options.resolveData ?? 'all')
          if (receipt.run) receipt.run = filterRun(receipt.run, options.resolveData)
          if (receipt.step) receipt.step = filterStep(receipt.step, options)
          if (receipt.hook) receipt.hook = filterHook(receipt.hook, options)
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
      async get(runId, id, options = {}) {
        const slot = eventIdToSlot(id)
        const event = slot === null ? null : await authority.event(runId, slot)
        if (!event) throw new WorkflowWorldError('Workflow event not found', { status: 404 })
        return stripEventDataRefs(event, options.resolveData ?? 'all')
      },
      list: ({ runId, pagination, resolveData = 'all' }) =>
        page(authority.events(runId, pagination), event => stripEventDataRefs(event, resolveData)),
      listByCorrelationId: ({ runId, correlationId, pagination, resolveData = 'all' }) =>
        page(authority.events(runId, pagination, correlationId), event => stripEventDataRefs(event, resolveData)),
    },
  }
}

export const admissionCapabilities = { atomicStartHook: { active: true } }
