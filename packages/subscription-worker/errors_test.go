package worker

import (
	"context"
	"errors"
	"fmt"
	"testing"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func TestExecutorErrorsExportOnlyKnownRefusals(t *testing.T) {
	for _, known := range []Refusal{ErrReauthenticate, ErrAccessDenied, ErrRateLimited, ErrRequestRejected, ErrTemporary, ErrUnsupported, ErrCredential} {
		if got := executionFailure(fmt.Errorf("private executor details: %w", known)); got != known {
			t.Fatalf("known refusal %s was lost: %s", known, got)
		}
	}
	for _, unknown := range []error{errors.New("private provider details"), Refusal("fixture_private_token"), fmt.Errorf("wrapped: %w", Refusal("fixture_private_token"))} {
		if got := executionFailure(unknown); got != ErrProvider {
			t.Fatalf("unknown failure escaped: %s", got)
		}
	}
}

type refusalExecutor struct {
	fakeExecutor
	failure error
	chunk   bool
}

func (e refusalExecutor) ExecuteStream(context.Context, *core.Auth, ex.Request, ex.Options) (*ex.StreamResult, error) {
	if !e.chunk {
		return nil, e.failure
	}
	chunks := make(chan ex.StreamChunk, 1)
	chunks <- ex.StreamChunk{Err: e.failure}
	close(chunks)
	return &ex.StreamResult{Chunks: chunks}, nil
}

func TestStreamPreservesSafeExecutorRefusalsAtStartAndDuringStream(t *testing.T) {
	w, _, issuer := fixtureWorker(t, "claude")
	initial := mustAcquire(t, w)
	for _, chunk := range []bool{false, true} {
		for _, failure := range []error{ErrRateLimited, ErrAccessDenied, errors.New("fixture-private-provider-text")} {
			w.Executor = refusalExecutor{fakeExecutor: fakeExecutor{issuer}, failure: failure, chunk: chunk}
			emitted := false
			err := w.Stream(context.Background(), initial.Revision, "fixture-model", nil, func([]byte) error { emitted = true; return nil })
			want := executionFailure(failure)
			if !errors.Is(err, want) || emitted {
				t.Fatalf("chunk=%v got=%v want=%v emitted=%v", chunk, err, want, emitted)
			}
		}
	}
}
