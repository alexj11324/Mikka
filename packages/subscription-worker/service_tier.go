package worker

import (
	"context"
	"strings"
)

type requestedServiceTier string
type actualServiceTier string

const (
	serviceTierOmitted  requestedServiceTier = "omitted"
	serviceTierPriority requestedServiceTier = "priority"
)

// Independent from numeric timing. Only fixed enums cross private IPC, never
// a provider value, request, response, credential or model identity.
type serviceTierReceipt struct {
	Version        int                  `json:"version"`
	InputRequested requestedServiceTier `json:"inputRequested"`
	Requested      requestedServiceTier `json:"requested"`
	Created        actualServiceTier    `json:"created"`
	Completed      actualServiceTier    `json:"completed"`
	Incomplete     actualServiceTier    `json:"incomplete"`
}

func beginCodexServiceTier(ctx context.Context, value any) {
	r := timingFrom(ctx)
	if r == nil {
		return
	}
	requested := serviceTierOmitted
	if value, ok := value.(string); ok {
		// Match the pinned CPA converter's official fast/priority aliases.
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "fast", "priority":
			requested = serviceTierPriority
		}
	}
	r.mu.Lock()
	r.serviceTier = &serviceTierReceipt{
		Version: 1, InputRequested: requested, Requested: serviceTierOmitted,
		Created: "missing", Completed: "missing", Incomplete: "missing",
	}
	r.mu.Unlock()
}

// Called immediately before the single HTTP attempt, after conversion and
// the strict request filter. Intent is never substituted for the sent field.
func recordCodexRequestedTier(ctx context.Context, value any) {
	r := timingFrom(ctx)
	if r == nil {
		return
	}
	requested := serviceTierOmitted
	if value, ok := value.(string); ok && value == "priority" {
		requested = serviceTierPriority
	}
	r.mu.Lock()
	if r.serviceTier != nil {
		r.serviceTier.Requested = requested
	}
	r.mu.Unlock()
}

func nativeServiceTier(event map[string]any) actualServiceTier {
	response, _ := event["response"].(map[string]any)
	value, present := response["service_tier"]
	if !present {
		return "missing"
	}
	if value, ok := value.(string); ok {
		switch value {
		case "priority", "default", "auto", "flex":
			return actualServiceTier(value)
		}
	}
	return "unrecognized"
}

// Read native response events before CPA conversion can fill or reshape them.
// Missing fields and absent terminal events remain missing, including on Stop.
func recordCodexResponseTier(ctx context.Context, kind string, event map[string]any) {
	switch kind {
	case "response.created", "response.completed", "response.incomplete":
	default:
		return
	}
	r := timingFrom(ctx)
	if r == nil {
		return
	}
	tier := nativeServiceTier(event)
	r.mu.Lock()
	if r.serviceTier != nil {
		switch kind {
		case "response.created":
			r.serviceTier.Created = tier
		case "response.completed":
			r.serviceTier.Completed = tier
		case "response.incomplete":
			r.serviceTier.Incomplete = tier
		}
	}
	r.mu.Unlock()
}

func (r *timingRecorder) serviceTierSnapshot() *serviceTierReceipt {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.serviceTier == nil {
		return nil
	}
	value := *r.serviceTier
	return &value
}
