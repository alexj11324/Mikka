package worker

import (
	"context"
	exec "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	translator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"time"
)

// Streams one explicitly selected credential. Closing IPC cancels the provider
// context. No account pool, replay/retry or billing fallback exists here.
func (w *Worker) Stream(ctx context.Context, epoch int64, model string, payload []byte, emit func([]byte) error) error {
	if err := w.authorizeRuntime(ctx, epoch, "model", model); err != nil {
		return err
	}
	if w.Executor == nil || w.Executor.Identifier() != w.Scope.Provider {
		return ErrUnsupported
	}
	if !modelPattern.MatchString(model) {
		requestFailure(w.Scope.Provider, "input", "model_invalid", len(payload), modelRequestMaxBytes)
		return ErrProvider
	}
	if len(payload) > modelRequestMaxBytes {
		requestFailure(w.Scope.Provider, "input", "payload_too_large", len(payload), modelRequestMaxBytes)
		return ErrProvider
	}
	r, a, err := w.readyAuth(ctx, epoch)
	if err != nil {
		return err
	}
	execCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	result, err := w.Executor.ExecuteStream(execCtx, a, exec.Request{Model: model, Payload: payload, Format: translator.FormatOpenAI}, exec.Options{Stream: true, SourceFormat: translator.FormatOpenAI, ResponseFormat: translator.FormatOpenAI})
	if err != nil {
		return executionFailure(err)
	}
	if result == nil || result.Chunks == nil {
		requestFailure(w.Scope.Provider, "stream", "stream_unavailable", 0, 0)
		return ErrProvider
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err = w.activeRuntime(ctx, r.Epoch, model); err != nil {
				return err
			}
		case <-ctx.Done():
			return ErrUnavailable
		case chunk, ok := <-result.Chunks:
			if !ok {
				return nil
			}
			if chunk.Err != nil {
				return executionFailure(chunk.Err)
			}
			if len(chunk.Payload) > 65536 {
				requestFailure(w.Scope.Provider, "stream", "chunk_too_large", len(chunk.Payload), 65536)
				return ErrProvider
			}
			if err = w.activeRuntime(ctx, r.Epoch, model); err != nil {
				return err
			}
			if err = emit(chunk.Payload); err != nil {
				return ErrUnavailable
			}
		}
	}
}
