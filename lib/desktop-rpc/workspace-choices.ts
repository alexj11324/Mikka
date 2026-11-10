import { AsyncLocalStorage } from 'node:async_hooks'
import { COMMIT_EXECUTOR } from '../db/commit-effects'
import { currentRoute } from '../tracing/labels'
import type { EnterprisePrincipal } from '../enterprise/principal'

type PrincipalParts = readonly (string | null)[]
type WorkspaceChoiceIdentity = {
  userId: string
  nativeSessionId: string | undefined
  requestedId: string
  tokenWorkspaceId?: string
  principal?: EnterprisePrincipal
  acting?: { userId: string; tokenWorkspaceId?: string; enterprisePrincipal?: EnterprisePrincipal }
}
type PendingRows = {
  family: object; executor: object; request: object; identity: string
  promise: Promise<readonly object[]>
}
type ChoiceBatch = { active: boolean; pending: Set<PendingRows> }
const choices = new AsyncLocalStorage<ChoiceBatch>()

/** Opened only alongside the bounded Native read batch, never by an individual
 * workspace reader. Detached work cannot retain a completed batch's queue. */
export async function withPendingWorkspaceChoices<T>(work: () => Promise<T>): Promise<T> {
  const scope: ChoiceBatch = { active: true, pending: new Set() }
  try { return await choices.run(scope, work) }
  finally { scope.active = false; scope.pending.clear() }
}

function principalParts(value: EnterprisePrincipal | undefined): PrincipalParts | null {
  if (value === undefined) return ['none']
  if (!value || typeof value !== 'object' || Object.getOwnPropertySymbols(value).length) return null
  const nonempty = (input: unknown): input is string => typeof input === 'string' && input.length > 0
  const exact = (keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
  switch (value.kind) {
    case 'session':
      return exact(['kind', 'sessionId']) && nonempty(value.sessionId) ? ['session', value.sessionId] : null
    case 'pat':
      return exact(['kind', 'tokenId', 'workspaceId']) && nonempty(value.tokenId) && nonempty(value.workspaceId)
        ? ['pat', value.tokenId, value.workspaceId] : null
    case 'delegation':
      return exact(['kind', 'workspaceId', 'credentialId', 'credentialKind']) && nonempty(value.credentialId)
        && (value.workspaceId === undefined || nonempty(value.workspaceId))
        && (value.credentialKind === 'oauth' || value.credentialKind === 'run')
        ? ['delegation', value.workspaceId ?? null, value.credentialId, value.credentialKind] : null
    case 'admission':
      return exact(['kind', 'runId', 'workspaceId']) && nonempty(value.runId) && nonempty(value.workspaceId)
        ? ['admission', value.runId, value.workspaceId] : null
    default: return null
  }
}

function identityKey(value: WorkspaceChoiceIdentity): string | null {
  const validPin = (input: unknown) => input === undefined || typeof input === 'string' && input.length > 0
  if (typeof value.userId !== 'string' || !value.userId || typeof value.nativeSessionId !== 'string' || !value.nativeSessionId
    || typeof value.requestedId !== 'string' || !validPin(value.tokenWorkspaceId)) return null
  const principal = principalParts(value.principal), acting = value.acting
  const inherited = principalParts(acting?.enterprisePrincipal)
  if (!principal || !inherited || acting && (typeof acting.userId !== 'string' || !acting.userId || !validPin(acting.tokenWorkspaceId))) return null
  return JSON.stringify([value.userId, value.nativeSessionId, value.requestedId, value.tokenWorkspaceId ?? null, principal,
    acting ? [acting.userId, acting.tokenWorkspaceId ?? null, inherited] : null])
}

/** Share one new scalar-row SELECT only with equivalent callers that arrived
 * before its dispatch. The private family token names the exact projection,
 * predicates and ordering; other readers cannot accidentally join this SQL.
 * No in-flight/completed authority is cached: the entry is removed before
 * read() constructs/assimilates its Drizzle thenable, including sync failures.
 * Each caller still applies its own current pin, kind and Enterprise checks. */
export function readPendingWorkspaceChoices<Row extends object>(
  input: { family: object; database: object; request: object | undefined; transaction: boolean; identity: WorkspaceChoiceIdentity },
  read: () => PromiseLike<Row[]>,
): Promise<Row[]> {
  const ownRows = (rows: readonly Row[]) => rows.map(row => ({ ...row }))
  const independently = () => {
    try { return Promise.resolve(read()) } catch (error) { return Promise.reject(error) }
  }
  const scope = choices.getStore()
  if (!scope?.active || input.transaction || !input.request || /^(?:after|cron|workflow):/.test(currentRoute() ?? ''))
    return independently()
  const identity = identityKey(input.identity)
  if (!identity) return independently()
  const executor = (input.database as { [COMMIT_EXECUTOR]?: object })[COMMIT_EXECUTOR] ?? input.database
  const prior = [...scope.pending].find(pending => pending.family === input.family && pending.executor === executor
    && pending.request === input.request && pending.identity === identity)
  if (prior) return (prior.promise as Promise<readonly Row[]>).then(ownRows)
  let resolve!: (rows: readonly Row[]) => void, reject!: (error: unknown) => void
  const promise = new Promise<readonly Row[]>((accept, fail) => { resolve = accept; reject = fail })
  const pending: PendingRows = { family: input.family, executor, request: input.request, identity, promise }
  scope.pending.add(pending)
  queueMicrotask(() => {
    // A subsequent call must read again even while this SQL is still pending.
    scope.pending.delete(pending)
    Promise.resolve().then(read).then(resolve, reject)
  })
  return promise.then(ownRows)
}
