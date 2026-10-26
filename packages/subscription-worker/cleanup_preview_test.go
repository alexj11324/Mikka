package worker

import (
 "context"
 "errors"
 "encoding/json"
 "testing"
)

type cleanupPreviewStore struct { deletes int }
func (s *cleanupPreviewStore) Create(context.Context,string,[]byte) error { return errors.New("unexpected create") }
func (s *cleanupPreviewStore) Read(context.Context,string)([]byte,error) { return nil,errors.New("unexpected read") }
func (s *cleanupPreviewStore) Delete(context.Context,string) error { s.deletes++;return errors.New("unexpected delete") }

func cleanupPreviewFixture(t *testing.T, active int)(*Worker,*cleanupPreviewStore,string,string){
 t.Helper()
 repo:=&Repository{DB:testDB(t)}
 scope:=fixtureScope("claude")
 if err:=repo.Create(context.Background(),scope);err!=nil{t.Fatal(err)}
 store:=&cleanupPreviewStore{}
 w:=&Worker{Repo:repo,Scope:scope,Secrets:store,AccessSecrets:store}
 for i:=0;i<active;i++{
  _,err:=repo.DB.Exec(`insert into byos_secret_artifacts(name,"connectionId","ownerId","workspaceId",provider,kind,"notBefore","publishedAt") values($1,$2,$3,$4,$5,'grant',now(),now())`,"mikka-byos-"+newID(),scope.ConnectionID,scope.OwnerID,scope.WorkspaceID,scope.Provider)
  if err!=nil{t.Fatal(err)}
 }
 // Synthetic pre-tombstoned metadata only: no store Delete or SQL DELETE.
 name,operation,state:="mikka-byos-"+newID(),newID(),hashText(newID())
 _,err:=repo.DB.Exec(`insert into byos_secret_artifacts(name,"connectionId","ownerId","workspaceId",provider,kind,"operationId","notBefore","deletedAt") values($1,$2,$3,$4,$5,'oauth',$6,now(),now())`,name,scope.ConnectionID,scope.OwnerID,scope.WorkspaceID,scope.Provider,operation)
 if err!=nil{t.Fatal(err)}
 _,err=repo.DB.Exec(`insert into byos_oauth_attempts("stateHash","sessionHash","connectionId","ownerId","workspaceId","operationId","secretName","expiresAt") values($1,$2,$3,$4,$5,$6,$7,now()-interval '1 minute')`,state,hashText(newID()),scope.ConnectionID,scope.OwnerID,scope.WorkspaceID,operation,name)
 if err!=nil{t.Fatal(err)}
 t.Cleanup(func(){t.Logf("retained cleanup preview fixture connection: %s",scope.ConnectionID)})
 return w,store,state,name
}
func assertCleanupPreviewRetained(t *testing.T,w *Worker,store *cleanupPreviewStore,active int,state string){
 t.Helper()
 var claimed,remaining,attempts int
 err:=w.Repo.DB.QueryRow(`select count(*) filter(where "deletingAt" is not null),count(*) filter(where "deletedAt" is null) from byos_secret_artifacts where "connectionId"=$1`,w.Scope.ConnectionID).Scan(&claimed,&remaining)
 if err!=nil||claimed!=0||remaining!=active||store.deletes!=0{t.Fatal("cleanup mutated retained fixture",err,claimed,remaining,store.deletes)}
 if err=w.Repo.DB.QueryRow(`select count(*) from byos_oauth_attempts where "stateHash"=$1`,state).Scan(&attempts);err!=nil||attempts!=1{t.Fatal("attempt not retained",err)}
}
func TestCleanupPauseRetainsArtifactsAndAttempts(t *testing.T){
 w,store,state,name:=cleanupPreviewFixture(t,5)
 enrollment,transfer:=newID(),newID()
 _,setupErr:=w.Repo.DB.Exec(`insert into byos_enrollment_transfers("enrollmentId","transferId","connectionId","ownerId","workspaceId",principal,"databaseIdentity","escrowDigest","providerSubject",epoch,"operationId","boundAt","sourceCreationState","attemptCreationSettled") values($1,$2,$3,$4,$5,'synthetic', $6,$6,'synthetic',1,$7,now(),'settled',true)`,enrollment,transfer,w.Scope.ConnectionID,w.Scope.OwnerID,w.Scope.WorkspaceID,hashText(newID()),newID())
 if setupErr!=nil{t.Fatal(setupErr)}
 _,setupErr=w.Repo.DB.Exec(`insert into byos_enrollment_sources("enrollmentId",kind,"connectionId") values($1,'escrow',$2),($1,'attempt',$2)`,enrollment,w.Scope.ConnectionID)
 if setupErr!=nil{t.Fatal(setupErr)}

 calls:=0
 w.cleanupObserver=&cleanupPreviewObserver{ArtifactBudget:4,AttemptBudget:1,Observe:func(p cleanupPreview)error{
  calls++
  evidence,marshalErr:=json.Marshal(p);if marshalErr!=nil{t.Fatal(marshalErr)};t.Logf("retained cleanup exact inventory: %s",evidence)
  if len(p.EnrollmentRows)!=2{t.Fatal("missing exact enrollment composite PKs")}
  for _,row:=range p.EnrollmentRows{if row.EnrollmentID!=enrollment||row.TransferID!=transfer||row.ConnectionID!=w.Scope.ConnectionID||!row.Eligible||!row.Settled||row.RetainSource{t.Fatal("enrollment association mismatch")}}

  if p.Scope!=w.Scope||p.Status!="blocked"||p.EffectsComplete||p.Enrollment==""||p.ArtifactLimit!=4||len(p.Artifacts)!=4||len(p.Attempts)!=1||p.Attempts[0].StateHash!=state||p.Attempts[0].ArtifactName!=name{t.Fatal("inaccurate or approvable preview")}
  rows,err:=w.Repo.DB.Query(`select name from byos_secret_artifacts where "connectionId"=$1 and "deletedAt" is null order by name limit 4`,w.Scope.ConnectionID)
  if err!=nil{t.Fatal(err)};defer rows.Close()
  i:=0;for rows.Next(){var exact string;if rows.Scan(&exact)!=nil||i>=len(p.Artifacts)||p.Artifacts[i].Name!=exact{t.Fatal("limit/order mismatch")};i++};if rows.Err()!=nil||i!=4{t.Fatal("readback mismatch")}
  return nil
 }}
 _,err:=w.Cleanup(context.Background())
 if !errors.Is(err,ErrCleanupPaused)||errors.Is(err,errCleanupPreviewRefused)||calls!=1{t.Fatal("observer success resumed cleanup",err)}
 assertCleanupPreviewRetained(t,w,store,5,state)
 w.cleanupObserver.Observe=func(cleanupPreview)error{return errors.New("synthetic observer failure")}
 _,err=w.Cleanup(context.Background());if !errors.Is(err,ErrCleanupPaused)||!errors.Is(err,errCleanupPreviewRefused){t.Fatal("observer failure resumed cleanup",err)}
 assertCleanupPreviewRetained(t,w,store,5,state)
 // A foreign transfer must be refused, never silently omitted by an owner filter.
 if _,err:=w.Repo.DB.Exec(`update byos_enrollment_transfers set "ownerId"='foreign-fixture' where "enrollmentId"=$1`,enrollment);err!=nil{t.Fatal(err)}
 w.cleanupObserver.Observe=func(cleanupPreview)error{t.Fatal("foreign enrollment reached observer");return nil}
 if _,err:=w.Cleanup(context.Background());!errors.Is(err,errCleanupPreviewRefused){t.Fatal("foreign enrollment not refused",err)}
 assertCleanupPreviewRetained(t,w,store,5,state)
 // Retained active OAuth artifact: its attempt becomes eligible only if an
 // approved future store deletion succeeds. No store call is made here.
 future,futureStore,futureState,futureName:=cleanupPreviewFixture(t,0)
 if _,err:=future.Repo.DB.Exec(`update byos_secret_artifacts set "deletedAt"=null,"publishedAt"=now() where name=$1`,futureName);err!=nil{t.Fatal(err)}
 future.cleanupObserver=&cleanupPreviewObserver{ArtifactBudget:1,AttemptBudget:1,Observe:func(p cleanupPreview)error{
  if len(p.Attempts)!=1||p.Attempts[0].StateHash!=futureState||p.Attempts[0].EligibleNow{t.Fatal("future attempt PK not frozen")}
  evidence,marshalErr:=json.Marshal(p);if marshalErr!=nil{t.Fatal(marshalErr)};t.Logf("retained cleanup future exact inventory: %s",evidence)
  return nil
 }}
 if _,err:=future.Cleanup(context.Background());!errors.Is(err,ErrCleanupPaused)||errors.Is(err,errCleanupPreviewRefused){t.Fatal(err)}
 assertCleanupPreviewRetained(t,future,futureStore,1,futureState)
}
func TestCleanupPauseRejectsOwnershipAndBudget(t *testing.T){
 w,store,state,_:=cleanupPreviewFixture(t,2)
 original:=w.Scope
 called:=false
 observer:=func(cleanupPreview)error{called=true;return nil}
 w.cleanupObserver=&cleanupPreviewObserver{ArtifactBudget:4,AttemptBudget:1,Observe:observer}
 w.Scope.OwnerID="foreign-owner"
 _,err:=w.Cleanup(context.Background());if !errors.Is(err,ErrCleanupPaused)||!errors.Is(err,errCleanupPreviewRefused){t.Fatal("foreign owner not refused")}
 w.Scope=original
 for _,budgets:=range [][2]int{{1,1},{4,0},{5,1},{-1,1},{4,10001}}{
  w.cleanupObserver=&cleanupPreviewObserver{ArtifactBudget:budgets[0],AttemptBudget:budgets[1],Observe:observer}
  _,err=w.Cleanup(context.Background());if !errors.Is(err,ErrCleanupPaused)||!errors.Is(err,errCleanupPreviewRefused){t.Fatal("budget not refused",budgets)}
 }
 w.cleanupObserver=&cleanupPreviewObserver{ArtifactBudget:4,AttemptBudget:1,Observe:observer}
 w.Scope.WorkspaceID="foreign-workspace"
 _,err=w.Cleanup(context.Background());if !errors.Is(err,ErrCleanupPaused)||!errors.Is(err,errCleanupPreviewRefused){t.Fatal("foreign workspace not refused")}
 w.Scope=original
 // Keep the malformed synthetic row for inspection; no cleanup or deletion.
 _,err=w.Repo.DB.Exec(`update byos_secret_artifacts set "ownerId"='foreign-owner' where "connectionId"=$1 and "deletedAt" is null`,original.ConnectionID)
 if err!=nil{t.Fatal(err)}
 _,err=w.Cleanup(context.Background());if !errors.Is(err,ErrCleanupPaused)||!errors.Is(err,errCleanupPreviewRefused){t.Fatal("foreign artifact ownership hidden")}
 if called{t.Fatal("invalid preview exposed")}
 assertCleanupPreviewRetained(t,w,store,2,state)
}
func TestCleanupPauseRejectsCrossScopeAttemptAlias(t *testing.T){
 w,store,state,name:=cleanupPreviewFixture(t,1)
 foreign:=fixtureScope("claude")
 if err:=w.Repo.Create(context.Background(),foreign);err!=nil{t.Fatal(err)}
 foreignState:=hashText(newID())
 _,err:=w.Repo.DB.Exec(`insert into byos_oauth_attempts("stateHash","sessionHash","connectionId","ownerId","workspaceId","operationId","secretName","expiresAt") values($1,$2,$3,$4,$5,$6,$7,now()-interval '1 minute')`,foreignState,hashText(newID()),foreign.ConnectionID,foreign.OwnerID,foreign.WorkspaceID,newID(),name)
 if err!=nil{t.Fatal(err)}
 called:=false
 w.cleanupObserver=&cleanupPreviewObserver{ArtifactBudget:4,AttemptBudget:2,Observe:func(cleanupPreview)error{called=true;return nil}}
 _,err=w.Cleanup(context.Background());if !errors.Is(err,ErrCleanupPaused)||!errors.Is(err,errCleanupPreviewRefused)||called{t.Fatal("cross-scope alias hidden by SQL filter")}
 assertCleanupPreviewRetained(t,w,store,1,state)
 var n int
 if err=w.Repo.DB.QueryRow(`select count(*) from byos_oauth_attempts where "stateHash"=$1`,foreignState).Scan(&n);err!=nil||n!=1{t.Fatal("foreign attempt mutated")}
 t.Logf("retained foreign alias fixture connection: %s",foreign.ConnectionID)
}
func TestCleanupPauseFailsClosedBeforeDatabase(t *testing.T){
 called:=false
 w:=&Worker{cleanupObserver:&cleanupPreviewObserver{ArtifactBudget:4,AttemptBudget:1,Observe:func(cleanupPreview)error{called=true;return nil}}}
 _,err:=w.Cleanup(context.Background())
 if !errors.Is(err,ErrCleanupPaused)||!errors.Is(err,errCleanupPreviewRefused)||called{t.Fatal("pause hook did not precede product cleanup")}
 // Unconfigured workers retain the original unsupported-store behavior.
 w.cleanupObserver=nil
 _,err=w.Cleanup(context.Background());if err!=ErrUnsupported{t.Fatal("nil observer changed product behavior")}
}
