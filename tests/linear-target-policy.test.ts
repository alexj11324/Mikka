import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { QueryBuilder, type PgTable, type SelectedFields } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

function reader(rows:unknown[][]) {
  let index=0, writes=0
  const executor={
    select() {
      assert.ok(index<rows.length,'unexpected publication read')
      const result=rows[index++]
      const chain={from:()=>chain,innerJoin:()=>chain,where:()=>chain,for:async()=>result,limit:async()=>result}
      return chain
    },
    insert() {writes++;throw new Error('unexpected insert')},
    update() {writes++;throw new Error('unexpected update')},
  }
  return {executor,get writes(){return writes},get reads(){return index}}
}
const issue={id:randomUUID(),userId:'owner',workspaceId:randomUUID(),ownershipState:'bound',scope:'workspace',linearSyncPolicy:'explicit',linearSyncBlocked:false,scopeVersion:2,content:{type:'doc',content:[]}}
const expectedMembershipSql = "select \"mikka_workspaces\".\"id\", \"mikka_workspaces\".\"kind\", \"mikka_organization_workspaces\".\"organizationId\" from \"mikka_workspaces\" inner join \"mikka_workspace_members\" on \"mikka_workspace_members\".\"workspaceId\" = \"mikka_workspaces\".\"id\" left join \"mikka_organization_workspaces\" on \"mikka_organization_workspaces\".\"workspaceId\" = \"mikka_workspaces\".\"id\" where (\"mikka_workspace_members\".\"userId\" = $1 and \"mikka_workspace_members\".\"status\" = $2 and \"mikka_workspaces\".\"id\" = $3 and (\"mikka_workspaces\".\"kind\" = $4 or (\"mikka_workspaces\".\"kind\" = $5 and \"mikka_workspaces\".\"userId\" = $6))) order by \"mikka_workspaces\".\"createdAt\" asc"
const workspace = { select: (projection: Record<string, unknown>) => {
  assert.deepEqual(Object.keys(projection), ['id', 'kind', 'organizationId'])
  let source: PgTable | undefined, member: PgTable | undefined, organization: PgTable | undefined
  let memberJoin: SQL | undefined, organizationJoin: SQL | undefined
  const chain = {
    from: (table: PgTable) => { assert.equal(source, undefined); source = table; return chain },
    innerJoin: (table: PgTable, condition: SQL) => {
      assert.ok(source); assert.equal(member, undefined)
      member = table; memberJoin = condition
      return chain
    },
    leftJoin: (table: PgTable, condition: SQL) => {
      assert.ok(member); assert.equal(organization, undefined)
      organization = table; organizationJoin = condition
      return chain
    },
    where: (condition: SQL) => {
      assert.ok(source && member && organization && memberJoin && organizationJoin)
      const query = new QueryBuilder().select(projection as SelectedFields).from(source)
        .innerJoin(member, memberJoin).leftJoin(organization, organizationJoin).where(condition)
      return { orderBy: async (order: SQL) => {
        const compiled = query.orderBy(order).toSQL()
        let actualSql = compiled.sql
        // Expand only these three declaration/qualifier pairs. The complete
        // statement below still rejects a wrong base table, column or binding.
        for (const [table, name] of [['mikka_workspaces', 'w'], ['mikka_workspace_members', 'm'], ['mikka_organization_workspaces', 'o']]) {
          actualSql = actualSql.replaceAll('"' + table + '" "' + name + '"', '"' + table + '"')
            .replaceAll('"' + name + '".', '"' + table + '".')
        }
        assert.equal(actualSql, expectedMembershipSql)
        assert.deepEqual(compiled.params, [issue.userId, 'active', issue.workspaceId, 'team', 'personal', issue.userId])
        // This active Shared fixture is not linked to an Organization. Keep
        // the real Enterprise filter in the call path with its SQL NULL link.
        return [{ id: issue.workspaceId, kind: 'team', organizationId: null }]
      } }
    },
  }
  return chain
} }
const globals=globalThis as typeof globalThis & {linearTargetProbe:{tx:unknown;workspace:typeof workspace}}
globals.linearTargetProbe={tx:null,workspace}

test('unlinked workspace has no fallback to an active account team',async()=>{
  const fake=reader([[issue],[]]);globals.linearTargetProbe.tx=fake.executor
  const {reserveLinearPublication,LinearTargetNotVerifiedError}=await import('../lib/linear-sync/publication')
  await assert.rejects(reserveLinearPublication(issue.id),LinearTargetNotVerifiedError)
  assert.equal(fake.reads,2);assert.equal(fake.writes,0)
})

test('a verified link keeps its own target and an existing publication',async()=>{
  const publication={id:randomUUID(),issueId:issue.id,ownerId:issue.userId,teamSyncId:randomUUID(),scopeVersion:2,linearIssueId:randomUUID(),retiredAt:null}
  const team={id:publication.teamSyncId,ownerId:issue.userId,workspaceId:issue.workspaceId,active:true}
  const link={id:randomUUID(),issueId:issue.id,ownerId:issue.userId,teamSyncId:team.id,linearIssueId:publication.linearIssueId,publicationId:publication.id,externalTargetVerified:true,remoteRemovedAt:null}
  const fake=reader([[issue],[{link,team}],[publication],[]]);globals.linearTargetProbe.tx=fake.executor
  const {reserveLinearPublication}=await import('../lib/linear-sync/publication')
  const result=await reserveLinearPublication(issue.id)
  assert.ok(result);assert.equal(result.team.id,team.id);assert.equal(result.publication.linearIssueId,link.linearIssueId);assert.equal(fake.writes,0)
})

test('an in-flight publication is retired if its verified link disappears',async()=>{
  const fake=reader([[{id:issue.id}],[]])
  const {requireCurrentPublication,RetiredPublicationError}=await import('../lib/linear-sync/publication')
  const team={id:randomUUID(),workspaceId:issue.workspaceId,ownerId:issue.userId}
  const snapshot={issue,team,publication:{id:randomUUID(),scopeVersion:2,linearIssueId:randomUUID(),teamSyncId:team.id},fence:undefined} as unknown as Parameters<typeof requireCurrentPublication>[0]
  await assert.rejects(requireCurrentPublication(snapshot,fake.executor as unknown as Parameters<typeof requireCurrentPublication>[1]),RetiredPublicationError)
  assert.equal(fake.reads,2);assert.equal(fake.writes,0)
})
