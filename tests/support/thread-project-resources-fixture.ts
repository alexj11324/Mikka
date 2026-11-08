import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mock } from 'node:test'
import { ActionFailureError } from '../../lib/action-error'

type Query = { query: unknown }
type ResourceRun = {
  id: string; userId: string; workspaceId: string; issueId: string; agentId: string;
  deviceId: string; deviceRepoId: string; baseBranch: string | null; runHarness: string;
  agentDefinition?: { harness?: string; projectExecution?: unknown };
}
type Fixture = {
  pool: Query; client: Query; run: ResourceRun; lockedAssertions: 0 | 1;
  lockedRefusal?: ActionFailureError;
  outer: number; inner: number; held: boolean;
}
const admission = new AsyncLocalStorage<Fixture>()
const resourceIdentity = (run: ResourceRun) => ({
  id: run.id, userId: run.userId, workspaceId: run.workspaceId, issueId: run.issueId,
  agentId: run.agentId, deviceId: run.deviceId, deviceRepoId: run.deviceRepoId,
  baseBranch: run.baseBranch, harness: run.agentDefinition?.harness ?? run.runHarness,
  projectExecution: run.agentDefinition?.projectExecution,
})
const unexpected = (method: string) => () => assert.fail(`Unexpected runtime resource fixture call: ${method}`)

// These unit suites exercise runtime/credential orchestration, while the PG
// suites exercise authorization. Pin both new admission calls to the exact
// synthetic target and require the locked assertion to borrow the outer lease.
mock.module(new URL('../../lib/project-resources/run-lease.ts', import.meta.url).href, { namedExports: {
  withRunProjectResources: async (query: Query, run: ResourceRun, operation: () => Promise<unknown>) => {
    const fixture = admission.getStore()
    assert.ok(fixture, 'resource admission requires an explicit fixture')
    assert.equal(query, fixture.pool)
    assert.deepEqual(resourceIdentity(run), resourceIdentity(fixture.run))
    assert.equal(fixture.held, false)
    fixture.outer++
    fixture.held = true
    try { return await operation() } finally { fixture.held = false }
  },
  assertRunProjectResources: async (query: Query, run: ResourceRun) => {
    const fixture = admission.getStore()
    assert.ok(fixture?.held, 'locked resource admission must borrow its outer lease')
    assert.equal(query, fixture.client, 'the locked target is checked on the existing APP executor')
    assert.deepEqual(resourceIdentity(run), resourceIdentity(fixture.run))
    fixture.inner++
    if (fixture.lockedRefusal) throw fixture.lockedRefusal
  },
  withRunProjectExecution: unexpected('withRunProjectExecution'),
  assertRunProjectExecution: unexpected('assertRunProjectExecution'),
  isProjectExecutionRefusal: (error: unknown) => error instanceof ActionFailureError
    && ['projectRepositoryDenied', 'projectEnvironmentUnavailable', 'projectArchived'].includes(error.code),
} })

const preflight = 'SELECT r.* FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId" WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 AND r."workspaceId"=b."workspaceId"'
export function threadResourcePreflight(sql: string, values: unknown[], run: ResourceRun) {
  if (sql.replace(/\s+/g, ' ').trim() !== preflight) return undefined
  assert.deepEqual(values, [run.id, run.userId, run.workspaceId])
  return { rows: [{ ...run }], rowCount: 1 }
}

export async function withThreadProjectResources<T>(
  input: Pick<Fixture, 'pool' | 'client' | 'run'> & { lockedAssertions?: 0 | 1; lockedRefusal?: ActionFailureError }, operation: () => Promise<T>,
): Promise<T> {
  const fixture: Fixture = { ...input, lockedAssertions: input.lockedAssertions ?? 1, outer: 0, inner: 0, held: false }
  try { return await admission.run(fixture, operation) }
  finally {
    assert.equal(fixture.outer, 1, 'runtime orchestration always enters its scoped resource boundary')
    assert.equal(fixture.inner, fixture.lockedAssertions, 'the actual locked Run is rechecked before runtime side effects')
    assert.equal(fixture.held, false)
  }
}
