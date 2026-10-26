package worker

import (
 "context"
 "database/sql"
 "errors"
 "regexp"
 "time"
)

const ErrCleanupPaused Refusal = "cleanup_paused_test_observer"
const errCleanupPreviewRefused Refusal = "cleanup_preview_refused"

// Unexported, never configurable through IPC/env/production constructors.
// This is inventory of a snapshot, not a claim, lock, approval or resume token.
type cleanupPreviewObserver struct {
 ArtifactBudget int
 AttemptBudget int
 Observe func(cleanupPreview) error
}
type cleanupArtifactCandidate struct { Name, Kind string }
type cleanupAttemptCandidate struct { StateHash, ArtifactName, OperationID string; EligibleNow bool }
type cleanupEnrollmentCandidate struct { EnrollmentID, Kind, TransferID, ConnectionID string; Eligible, Settled, RetainSource bool }
type cleanupPreview struct {
 Scope Scope
 Artifacts []cleanupArtifactCandidate
 Attempts []cleanupAttemptCandidate
 ArtifactLimit int
 EffectsComplete bool
 Enrollment string
 EnrollmentRows []cleanupEnrollmentCandidate
 Status string
}
var cleanupStateHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (w *Worker) pauseCleanup(ctx context.Context) (CleanupStatus,error) {
 status:=CleanupStatus{ProviderRevocation:"not_implemented"}
 observer:=*w.cleanupObserver
 preview,err:=w.previewCleanup(ctx,observer)
 if err!=nil { return status,errors.Join(ErrCleanupPaused,errCleanupPreviewRefused) }
 // Even a successful observer cannot authorize cleanup or fall through.
 if observer.Observe(preview)!=nil { return status,errors.Join(ErrCleanupPaused,errCleanupPreviewRefused) }
 return status,ErrCleanupPaused
}

func (w *Worker) previewCleanup(ctx context.Context,observer cleanupPreviewObserver) (cleanupPreview,error) {
 out:=cleanupPreview{Scope:w.Scope,ArtifactLimit:4,EffectsComplete:false,Enrollment:"blocked: enrollment effects not modeled",Status:"blocked"}
 if observer.Observe==nil || observer.ArtifactBudget<0 || observer.ArtifactBudget>4 || observer.AttemptBudget<0 || observer.AttemptBudget>10000 || !validScope(w.Scope) || w.Repo==nil || w.Repo.DB==nil {return out,errCleanupPreviewRefused}
 ctx,cancel:=context.WithTimeout(ctx,5*time.Second);defer cancel()
 tx,err:=w.Repo.DB.BeginTx(ctx,&sql.TxOptions{Isolation:sql.LevelRepeatableRead,ReadOnly:true})
 if err!=nil{return out,errCleanupPreviewRefused};defer tx.Rollback()
 var authoritative Scope
 err=tx.QueryRowContext(ctx,`select id::text,"ownerId","workspaceId",provider from byos_connections where id=$1`,out.Scope.ConnectionID).Scan(&authoritative.ConnectionID,&authoritative.OwnerID,&authoritative.WorkspaceID,&authoritative.Provider)
 if err!=nil || authoritative!=out.Scope{return out,errCleanupPreviewRefused}
 // Same eligibility/order/limit as Cleanup, but no claim UPDATE or FOR UPDATE.
 // Deliberately omit owner/workspace/provider filters so corrupt foreign rows
 // under this connection are refused rather than silently omitted.
 rows,err:=tx.QueryContext(ctx,`select a.name,a.kind,a."ownerId",a."workspaceId",a.provider from byos_secret_artifacts a where a."connectionId"=$1 and a."deletedAt" is null and (a."publishedAt" is not null or a."notBefore"<=now()) and not exists(select 1 from byos_connections c where c.id=a."connectionId" and a.name in(c."secretName",c."accessSecretName",c."stagedSecretName",c."stagedAccessName")) and not exists(select 1 from byos_oauth_attempts o join byos_connections c on c.id=o."connectionId" where o."secretName"=a.name and o."consumedAt" is null and o."expiresAt">now() and o."operationId"=c."operationId" and c.state='pending') order by coalesce(a."deletingAt",'epoch'::timestamptz),a.name limit 4`,out.Scope.ConnectionID)
 if err!=nil{return out,errCleanupPreviewRefused}
 for rows.Next(){
  var candidate cleanupArtifactCandidate;var owner,workspace,provider string
  if rows.Scan(&candidate.Name,&candidate.Kind,&owner,&workspace,&provider)!=nil || owner!=out.Scope.OwnerID || workspace!=out.Scope.WorkspaceID || provider!=out.Scope.Provider || !validSecretName(candidate.Name) || (candidate.Kind!="grant"&&candidate.Kind!="access"&&candidate.Kind!="oauth") {rows.Close();return out,errCleanupPreviewRefused}
  out.Artifacts=append(out.Artifacts,candidate)
  if len(out.Artifacts)>observer.ArtifactBudget{rows.Close();return out,errCleanupPreviewRefused}
 }
 err=rows.Err();rows.Close();if err!=nil{return out,errCleanupPreviewRefused}
 selected:=[]string{"","","",""}
 for i,a:=range out.Artifacts{selected[i]=a.Name}
 // Match the production DELETE join exactly. Never SQL-filter attempt ownership:
 // an attempt in another scope that aliases the artifact would also be affected.
 rows,err=tx.QueryContext(ctx,`select o."stateHash",o."secretName",o."operationId"::text,o."connectionId"::text,o."ownerId",o."workspaceId",a."ownerId",a."workspaceId",a.provider,a.kind,coalesce(a."operationId"::text,''),a."deletedAt" is not null from byos_oauth_attempts o join byos_secret_artifacts a on o."secretName"=a.name where a."connectionId"=$1 and (a."deletedAt" is not null or (a.name in ($3,$4,$5,$6) and not a."createUncertain" and (not a."createStarted" or a."createSettled"))) order by o."stateHash",a.name limit $2`,out.Scope.ConnectionID,observer.AttemptBudget+1,selected[0],selected[1],selected[2],selected[3])
 if err!=nil{return out,errCleanupPreviewRefused}
 seen:=map[string]bool{};seenArtifacts:=map[string]bool{}
 for rows.Next(){
  var candidate cleanupAttemptCandidate;var connection,owner,workspace,artifactOwner,artifactWorkspace,provider,kind,operation string
  if rows.Scan(&candidate.StateHash,&candidate.ArtifactName,&candidate.OperationID,&connection,&owner,&workspace,&artifactOwner,&artifactWorkspace,&provider,&kind,&operation,&candidate.EligibleNow)!=nil || !cleanupStateHash.MatchString(candidate.StateHash) || !validSecretName(candidate.ArtifactName) || !uuidPattern.MatchString(candidate.OperationID) || candidate.OperationID!=operation || kind!="oauth" || connection!=out.Scope.ConnectionID || owner!=out.Scope.OwnerID || artifactOwner!=out.Scope.OwnerID || workspace!=out.Scope.WorkspaceID || artifactWorkspace!=out.Scope.WorkspaceID || provider!=out.Scope.Provider || seen[candidate.StateHash] || seenArtifacts[candidate.ArtifactName]{rows.Close();return out,errCleanupPreviewRefused}
  seen[candidate.StateHash]=true;seenArtifacts[candidate.ArtifactName]=true
  out.Attempts=append(out.Attempts,candidate)
  if len(out.Attempts)>observer.AttemptBudget{rows.Close();return out,errCleanupPreviewRefused}
 }
 err=rows.Err();rows.Close();if err!=nil{return out,errCleanupPreviewRefused}
 // Freeze composite PKs and associations without contacting source stores.
 // Source custody/claim verification remains a separate blocking requirement.
 rows,err=tx.QueryContext(ctx,`select a."enrollmentId"::text,a.kind,t."transferId"::text,a."connectionId"::text,t."connectionId"::text,t."ownerId",t."workspaceId",(t."canonicalPublishedAt" is not null or t."boundAt" is not null or c.epoch>t.epoch),case a.kind when 'escrow' then t."sourceCreationState"='settled' else t."attemptCreationSettled" end,exists(select 1 from byos_environment_transfers e where e."enrollmentId"=t."enrollmentId" and e."retainSource") from byos_enrollment_sources a left join byos_enrollment_transfers t on t."enrollmentId"=a."enrollmentId" left join byos_connections c on c.id=a."connectionId" where (a."connectionId"=$1 or t."connectionId"=$1) and a."deletedAt" is null order by a."enrollmentId",a.kind limit 3`,out.Scope.ConnectionID)
 if err!=nil{return out,errCleanupPreviewRefused}
 enrollmentIDs:=map[string]bool{}
 for rows.Next(){
  var candidate cleanupEnrollmentCandidate;var connection,owner,workspace string
  if rows.Scan(&candidate.EnrollmentID,&candidate.Kind,&candidate.TransferID,&candidate.ConnectionID,&connection,&owner,&workspace,&candidate.Eligible,&candidate.Settled,&candidate.RetainSource)!=nil || !uuidPattern.MatchString(candidate.EnrollmentID) || !uuidPattern.MatchString(candidate.TransferID) || (candidate.Kind!="escrow"&&candidate.Kind!="attempt") || candidate.ConnectionID!=out.Scope.ConnectionID || connection!=out.Scope.ConnectionID || owner!=out.Scope.OwnerID || workspace!=out.Scope.WorkspaceID {rows.Close();return out,errCleanupPreviewRefused}
  key:=candidate.EnrollmentID+":"+candidate.Kind
  if enrollmentIDs[key]{rows.Close();return out,errCleanupPreviewRefused};enrollmentIDs[key]=true
  out.EnrollmentRows=append(out.EnrollmentRows,candidate)
  if len(out.EnrollmentRows)>2{rows.Close();return out,errCleanupPreviewRefused}
 }
 err=rows.Err();rows.Close();if err!=nil{return out,errCleanupPreviewRefused}
 out.Enrollment="blocked: exact source PKs recorded; external custody/claim not verified"
 if tx.Commit()!=nil{return out,errCleanupPreviewRefused}
 return out,nil
}
