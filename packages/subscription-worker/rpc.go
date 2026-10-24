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
	scanner.Buffer(make([]byte, 4096), 131072)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		var request struct {
			ID       string          `json:"id"`
			Method   string          `json:"method"`
			Revision int64           `json:"revision"`
			Model    string          `json:"model,omitempty"`
			Payload  json.RawMessage `json:"payload,omitempty"`
		}
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		var result any
		var err error
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || request.ID == "" || len(request.ID) > 64 {
			request.ID = ""
			err = ErrUnsupported
		} else {
			callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			switch request.Method {
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
