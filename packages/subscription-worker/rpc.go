package worker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"time"
)

// Private parent/worker IPC. Owner scope and dependencies are bound before
// Serve starts; requests cannot replace them or import credentials/endpoints.
func (w *Worker) Serve(ctx context.Context, input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 524288)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		var request struct {
			ID        string          `json:"id"`
			Method    string          `json:"method"`
			Revision  int64           `json:"revision"`
			Model     string          `json:"model,omitempty"`
			Payload   json.RawMessage `json:"payload,omitempty"`
			SessionID string          `json:"sessionId,omitempty"`
			State     string          `json:"state,omitempty"`
			Code      string          `json:"code,omitempty"`
		}
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		var result any
		var err error
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || request.ID == "" || len(request.ID) > 64 {
			request.ID = ""
			err = ErrUnsupported
		} else {
			timeout := 30 * time.Second
			if request.Method == "executeStream" {
				timeout = 270 * time.Second
			}
			callCtx, cancel := context.WithTimeout(ctx, timeout)
			switch request.Method {
			case "oauthStart":
				result, err = w.StartOAuth(callCtx, request.Revision, request.SessionID)
			case "oauthComplete":
				result, err = w.CompleteOAuth(callCtx, request.SessionID, request.State, request.Code)
			case "nativeAuth":
				if w.Scope.Provider == "codex" {
					result, err = w.CodexNativeAuth(callCtx, request.Revision)
				} else {
					result, err = w.ClaudeNativeAuth(callCtx, request.Revision)
				}
			case "executeStream":
				err = w.Stream(callCtx, request.Revision, request.Model, request.Payload, func(chunk []byte) error {
					return encoder.Encode(map[string]any{"id": request.ID, "chunk": string(chunk)})
				})
				result = map[string]bool{"done": true}
			case "status":
				result, err = w.Status(callCtx)
			case "acquire":
				result, err = w.Acquire(callCtx, request.Revision)
			case "refresh":
				result, err = w.Refresh(callCtx, request.Revision)
			case "recover":
				result, err = w.Recover(callCtx)
			case "disconnect":
				result, err = w.Disconnect(callCtx, request.Revision)
			case "execute":
				var response []byte
				response, err = w.Execute(callCtx, request.Revision, request.Model, request.Payload)
				if err == nil {
					if !json.Valid(response) {
						err = ErrProvider
					} else {
						result = json.RawMessage(response)
					}
				}
			default:
				err = ErrUnsupported
			}
			cancel()
		}
		message := map[string]any{"id": request.ID}
		if err != nil {
			message["error"] = safeCode(err)
		} else {
			message["result"] = result
		}
		if encoder.Encode(message) != nil {
			return ErrUnavailable
		}
	}
	if scanner.Err() != nil {
		return ErrUnsupported
	}
	return nil
}
