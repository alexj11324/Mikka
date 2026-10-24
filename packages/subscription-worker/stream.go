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
	if w.Executor == nil || w.Executor.Identifier() != w.Scope.Provider {
		return ErrUnsupported
	}
	if !modelPattern.MatchString(model) || len(payload) > 262144 {
		return ErrProvider
	}
	r, a, err := w.readyAuth(ctx, epoch)
	if err != nil {
		return err
	}
	execCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	result, err := w.Executor.ExecuteStream(execCtx, a, exec.Request{Model: model, Payload: payload, Format: translator.FormatOpenAI}, exec.Options{Stream: true, SourceFormat: translator.FormatOpenAI, ResponseFormat: translator.FormatOpenAI})
	if err != nil || result == nil || result.Chunks == nil {
		return ErrProvider
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if _, err = w.Repo.Connected(ctx, w.Scope, r.Epoch, r.Version); err != nil {
				return err
			}
		case <-ctx.Done():
			return ErrUnavailable
		case chunk, ok := <-result.Chunks:
			if !ok {
				return nil
			}
			if chunk.Err != nil || len(chunk.Payload) > 65536 {
				return ErrProvider
			}
			if _, err = w.Repo.Connected(ctx, w.Scope, r.Epoch, r.Version); err != nil {
				return err
			}
			if err = emit(chunk.Payload); err != nil {
				return ErrUnavailable
			}
		}
	}
}
