package worker

import (
 "context"
 "net/http"
 "net/http/httptest"
 "testing"
)

func TestVaultDenialSurvivesEnrollmentStart(t *testing.T) {
 for _, status := range []int{401,403} {
  server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.WriteHeader(status); _,_=w.Write([]byte("private-response-canary"))}))
  store,err:=NewInfisical(InfisicalConfig{Origin:server.URL,ProjectID:"fixture",Environment:"test",Path:"/attempts",Token:func(context.Context)(string,error){return "synthetic",nil},Client:server.Client()})
  if err!=nil {t.Fatal(err)}
  enrollment,_,_,_,_:=enrollmentFixture(); enrollment.Attempts=store
  _,err=enrollment.Start(context.Background(),"operator:fixture-principal")
  if err!=ErrStoreDenied {t.Fatalf("expected sanitized auth denial, got %v",err)}
  server.Close()
 }
}
