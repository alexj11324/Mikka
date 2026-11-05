package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"

	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func paddedRPCFrame(t *testing.T, method string, size int, newline bool) []byte {
	t.Helper()
	frame, err := json.Marshal(map[string]any{"id": "fixture", "method": method, "revision": 1, "model": "fixture-model", "payload": map[string]any{}})
	if err != nil || len(frame) > size {
		t.Fatal("invalid frame fixture")
	}
	frame = append(frame, bytes.Repeat([]byte(" "), size-len(frame))...)
	if newline {
		frame = append(frame, '\n')
	}
	return frame
}

func TestHostedModelRPCFrameBudgetIsInclusiveWithOrWithoutNewline(t *testing.T) {
	// No usable authority or stores: an accepted frame must still refuse
	// inference. A rejected frame must never reach even that method dispatch.
	w := Worker{ExecutionOnly: true}
	for _, newline := range []bool{true, false} {
		for _, size := range []int{2097152, 2097153} {
			t.Run(fmt.Sprintf("bytes=%d/newline=%t", size, newline), func(t *testing.T) {
				var out bytes.Buffer
				err := w.Serve(context.Background(), bytes.NewReader(paddedRPCFrame(t, "executeStream", size, newline)), &out)
				if size == 2097152 {
					if err != nil || !bytes.Contains(out.Bytes(), []byte(`"error"`)) {
						t.Fatal("inclusive model frame did not reach its unchanged authority refusal", err)
					}
				} else if err != ErrUnsupported || out.Len() != 0 {
					t.Fatal("oversized model frame crossed the scanner boundary", err)
				}
			})
		}
	}
}

type finalBytesAndEOFReader struct{ *bytes.Reader }

func (r finalBytesAndEOFReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if r.Len() == 0 {
		return n, io.EOF
	}
	return n, err
}

func TestHostedModelRPCEnforcesBudgetWhenFinalReadAlsoReturnsEOF(t *testing.T) {
	w := Worker{ExecutionOnly: true}
	for _, size := range []int{2097152, 2097153} {
		var out bytes.Buffer
		input := finalBytesAndEOFReader{bytes.NewReader(paddedRPCFrame(t, "executeStream", size, false))}
		err := w.Serve(context.Background(), input, &out)
		if size == 2097152 {
			if err != nil || !bytes.Contains(out.Bytes(), []byte(`"error"`)) {
				t.Fatal("inclusive EOF frame did not reach its authority refusal", err)
			}
		} else if err != ErrUnsupported || out.Len() != 0 {
			t.Fatal("Scanner's spare newline byte became an accepted payload byte", err)
		}
	}
}

func TestRPCFrameBudgetsCountCRBeforeLF(t *testing.T) {
	w := Worker{ExecutionOnly: true}
	for _, test := range []struct {
		method string
		limit  int
	}{{"executeStream", 2097152}, {"nativeStream", 524287}} {
		for _, size := range []int{test.limit, test.limit + 1} {
			// CR belongs to the frame; only the final LF is the delimiter.
			frame := append(paddedRPCFrame(t, test.method, size-1, false), '\r', '\n')
			var out bytes.Buffer
			err := w.Serve(context.Background(), bytes.NewReader(frame), &out)
			if size == test.limit {
				if err != nil || !bytes.Contains(out.Bytes(), []byte(`"error"`)) {
					t.Fatal("inclusive CRLF frame did not reach its existing refusal", err)
				}
			} else if err != ErrUnsupported || out.Len() != 0 {
				t.Fatal("CRLF normalization expanded a raw frame budget", err)
			}
		}
	}
}

func TestHostedModelBudgetDoesNotExpandAnyOtherRPCMethod(t *testing.T) {
	w := Worker{ExecutionOnly: true}
	for _, method := range []string{"execute", "nativeStream", "nativeContext", "prepare", "quota", "models", "usage", "cleanup", "oauthStart", "oauthResume", "oauthPoll", "oauthHandoff", "oauthComplete", "nativeAuth", "status", "acquire", "refresh", "recover", "disconnect", "unknown"} {
		t.Run(method, func(t *testing.T) {
			for _, size := range []int{524287, 524288} {
				var out bytes.Buffer
				err := w.Serve(context.Background(), bytes.NewReader(paddedRPCFrame(t, method, size, true)), &out)
				if size == 524287 {
					if err != nil || !bytes.Contains(out.Bytes(), []byte(`"error"`)) {
						t.Fatal("legacy frame no longer reaches its existing refusal", err)
					}
				} else if err != ErrUnsupported || out.Len() != 0 {
					t.Fatal("a non-model method gained a larger RPC frame", err)
				}
			}
		})
	}
}

func TestHostedModelRPCPreservesUTF8PayloadAndCredentialFence(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			w, _, _ := fixtureWorker(t, provider)
			initial := mustAcquire(t, w)
			closed := make(chan ex.StreamChunk)
			close(closed)
			executor := &requestBoundaryExecutor{ProviderExecutor: w.Executor, result: &ex.StreamResult{Chunks: closed}}
			w.Executor = executor
			record, err := w.Repo.Lookup(context.Background(), w.Scope)
			if err != nil {
				t.Fatal(err)
			}
			access := &boundedAccessStore{SecretStore: w.AccessSecrets, allowed: record.AccessName}
			w.ExecutionOnly, w.Secrets, w.AccessSecrets = true, nil, access
			payloadFor := func(text string) []byte {
				payload, err := json.Marshal(map[string]any{"model": "fixture-model", "stream": true, "messages": []any{map[string]any{"role": "user", "content": text}}})
				if err != nil {
					t.Fatal(err)
				}
				return payload
			}
			for _, size := range []int{266742, 1048576, 1048577} {
				t.Run(fmt.Sprintf("payload=%d", size), func(t *testing.T) {
					capacity := size - len(payloadFor(""))
					payload := payloadFor(strings.Repeat("汉", capacity/3) + strings.Repeat("x", capacity%3))
					if len(payload) != size {
						t.Fatal("fixture must have the exact UTF-8 input size")
					}
					frame, err := json.Marshal(map[string]any{"id": "fixture", "method": "executeStream", "revision": initial.Revision, "model": "fixture-model", "payload": json.RawMessage(payload)})
					if err != nil {
						t.Fatal(err)
					}
					executor.calls = 0
					beforeReads := access.reads
					var out bytes.Buffer
					logged := captureStderr(t, func() { err = w.Serve(context.Background(), bytes.NewReader(append(frame, '\n')), &out) })
					if err != nil {
						t.Fatal("bounded input failed at the RPC envelope", err)
					}
					var response struct {
						Error  string          `json:"error"`
						Result map[string]bool `json:"result"`
					}
					if json.Unmarshal(out.Bytes(), &response) != nil {
						t.Fatal("invalid RPC response")
					}
					if size <= 1048576 {
						if response.Error != "" || !response.Result["done"] || executor.calls != 1 || access.reads != beforeReads+1 || logged != "" {
							t.Fatal("valid UTF-8 input did not reach exactly one authorized inference")
						}
					} else if response.Error != string(ErrProvider) || executor.calls != 0 || access.reads != beforeReads || logged != fmt.Sprintf("subscription_request_failure %s input payload_too_large 1048577 1048576\n", provider) {
						t.Fatal("oversized model payload crossed the credential/inference fence")
					}
				})
			}
			after, err := w.Repo.Lookup(context.Background(), w.Scope)
			if err != nil || after.Version != record.Version || after.OperationID != record.OperationID {
				t.Fatal("transport budget changed credential custody")
			}
		})
	}
}
