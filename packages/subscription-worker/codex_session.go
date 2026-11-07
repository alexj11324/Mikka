package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

type codexSessionKey struct{}

// Only Stream installs this private context after its existing authorization
// and credential-readiness checks. The identifier is our own conversation
// routing scope, not a credential or authority cache. Token rotation keeps it;
// a new authorization epoch or another owner/binding/bot changes it.
func withCodexSession(ctx context.Context, scope Scope, use *RuntimeUse, epoch int64) context.Context {
	if scope.Provider != "codex" || !validScope(scope) || use == nil || !uuidPattern.MatchString(use.BindingID) || use.ConsumerID == "" || len(use.ConsumerID) > 128 || epoch <= 0 {
		return ctx
	}
	// WorkspaceID is the connection's custody workspace. BindingID and
	// ConsumerID separately isolate users of a shared connection in other teams.
	raw, _ := json.Marshal([]any{"mikka:codex:conversation:v1", scope.OwnerID, scope.WorkspaceID, scope.ConnectionID, use.BindingID, use.ConsumerID, epoch})
	digest := sha256.Sum256(raw)
	return context.WithValue(ctx, codexSessionKey{}, hex.EncodeToString(digest[:]))
}
