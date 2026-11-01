import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { normalizeRepository } from '@mikka/protocol/repository'
import type { readAuthorizedIssue } from '../github/user-access'
import { githubRepository } from '../github/run-pull-request'
import { FactoryError } from './contract'
import { factoryScopeAllows } from './scope'
import type { FactoryAuthorize } from './store'

type IssueReader=typeof readAuthorizedIssue
const urlSchema=z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*\/?$/)
export const monitorIssueLinkSchema=z.object({url:urlSchema}).strict()

/** A human links an existing remote issue. No create, update, sync, repair or
 * approval is dispatched; the immutable candidate supplies the repository. */
export function createFactoryMonitorIssueLinks(pool:Pool,authorize:FactoryAuthorize,readIssue:IssueReader){
  async function current(tx:PoolClient,userId:string,incidentId:string){
    const {rows:[hint]}=await tx.query(`SELECT i.*,t."scopeVersion" AS "taskScopeVersion",t.status AS "taskStatus",c.repository
      FROM factory_monitor_incidents i JOIN factory_tasks t ON t.id=i."taskId" AND t."userId"=i."userId"
      JOIN factory_candidates c ON c.id=i."candidateId" AND c."taskId"=t.id
      WHERE i.id=$1 AND i."userId"=$2`,[incidentId,userId])
    if(!hint)throw new FactoryError('factoryNotFound')
    const {rows:[source]}=await tx.query('SELECT "userId",scope,"scopeVersion" FROM issues WHERE id=$1 FOR SHARE',[hint.issueId])
    if(!factoryScopeAllows({userId,scopeVersion:hint.taskScopeVersion},source)||!await authorize(userId,hint.issueId,tx))throw new FactoryError('factoryNotFound')
    const {rows:[incident]}=await tx.query('SELECT * FROM factory_monitor_incidents WHERE id=$1 AND "userId"=$2 FOR UPDATE',[incidentId,userId])
    if(!incident||['cancelled','revoked'].includes(hint.taskStatus))throw new FactoryError('factoryStopped')
    const issueId=incident.followupIssueId??incident.issueId
    const {rows:[issue]}=await tx.query('SELECT "userId" FROM issues WHERE id=$1 FOR SHARE',[issueId])
    if(issue?.userId!==userId||!await authorize(userId,issueId,tx))throw new FactoryError('factoryNotFound')
    return {incidentId,issueId,sourceIssueId:incident.issueId,repository:String(hint.repository)}
  }
  async function transaction<T>(userId:string,id:string,work:(tx:PoolClient,state:Awaited<ReturnType<typeof current>>)=>Promise<T>){
    if(!z.uuid().safeParse(id).success)throw new FactoryError('factoryInvalid')
    const tx=await pool.connect()
    try{await tx.query('BEGIN');const result=await work(tx,await current(tx,userId,id));await tx.query('COMMIT');return result}
    catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
  }
  async function view(tx:PoolClient,state:Awaited<ReturnType<typeof current>>,userId:string){
    const {rows:[github]}=await tx.query('SELECT "remoteKey","githubIssueId",number,url,state,"githubUpdatedAt","verifiedAt" FROM github_issue_links WHERE "issueId"=$1 AND "ownerId"=$2',[state.issueId,userId])
    const {rows:[linear]}=await tx.query(`SELECT l."linearIssueId",l."linearIdentifier",l."teamSyncId" FROM linear_issue_links l
      JOIN linear_team_syncs t ON t.id=l."teamSyncId" AND t."ownerId"=l."ownerId" AND t.active
      JOIN linear_connections c ON c."userId"=l."ownerId" AND c."revokedAt" IS NULL
      WHERE l."issueId"=$1 AND l."ownerId"=$2 AND l."externalTargetVerified" AND l."remoteRemovedAt" IS NULL`,[state.issueId,userId])
    return {...state,github:github?{status:'mapped' as const,...github}:{status:'unmapped' as const},linear:linear?{status:'mapped' as const,...linear}:{status:'unmapped' as const}}
  }
  return {
    read:(userId:string,id:string)=>transaction(userId,id,(tx,state)=>view(tx,state,userId)),
    async linkGitHub(userId:string,id:string,headers:Headers,input:unknown){
      const parsed=monitorIssueLinkSchema.safeParse(input)
      if(!parsed.success)throw new FactoryError('factoryInvalid')
      const before=await transaction(userId,id,async(_tx,state)=>state)
      let repository:ReturnType<typeof githubRepository>
      let remoteKey:string
      try{remoteKey=before.repository.startsWith('v2/')?before.repository:normalizeRepository(before.repository).key;repository=githubRepository(remoteKey)}catch{throw new FactoryError('factoryMonitorRepositoryUnavailable')}
      const remote=new URL(parsed.data.url)
      if(remote.pathname.split('/').slice(1,3).join('/').toLowerCase()!==`${repository.owner}/${repository.repo}`.toLowerCase())throw new FactoryError('factoryMonitorRepositoryMismatch')
      // Provider IO is outside SQL locks. The final transaction rechecks current
      // source/logical issue authority and the exact persisted target again.
      const verified=await readIssue(headers,parsed.data.url)
      if(verified.userId!==userId)throw new FactoryError('factoryNotFound')
      return transaction(userId,id,async(tx,state)=>{
        if(state.issueId!==before.issueId||state.repository!==before.repository)throw new FactoryError('factoryStale')
        const {rows:[prior]}=await tx.query('SELECT "githubIssueId","remoteKey","repositoryId" FROM github_issue_links WHERE "issueId"=$1 FOR UPDATE',[state.issueId])
        if(prior&&(prior.githubIssueId!==verified.issueId||prior.remoteKey!==remoteKey||prior.repositoryId!==verified.repoId))throw new FactoryError('factoryMonitorIssueMappingConflict')
        const {rows:[other]}=await tx.query('SELECT "issueId" FROM github_issue_links WHERE "ownerId"=$1 AND "githubIssueId"=$2',[userId,verified.issueId])
        if(other&&other.issueId!==state.issueId)throw new FactoryError('factoryMonitorIssueMappingConflict')
        await tx.query(`INSERT INTO github_issue_links("issueId","ownerId","remoteKey","githubIssueId",number,url,"repositoryId","installationId","githubAccountId",state,"githubUpdatedAt")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT("issueId") DO UPDATE SET state=excluded.state,"githubUpdatedAt"=excluded."githubUpdatedAt","verifiedAt"=now(),"installationId"=excluded."installationId","githubAccountId"=excluded."githubAccountId"`,
        [state.issueId,userId,remoteKey,verified.issueId,verified.number,verified.url,verified.repoId,verified.installationId,verified.githubAccountId,verified.state,verified.updatedAt])
        return view(tx,state,userId)
      })
    },
  }
}
