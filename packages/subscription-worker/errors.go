package worker

import "errors"

// Codes cross private IPC. Raw provider, SQL, credential or HTTP error bodies do not.
type Refusal string

func (e Refusal) Error() string { return string(e) }

const (
	ErrUnavailable     Refusal = "account_unavailable"
	ErrStale           Refusal = "stale_operation"
	ErrBusy            Refusal = "credential_busy"
	ErrDatabase        Refusal = "metadata_unavailable"
	ErrCredential      Refusal = "invalid_credential_bundle"
	ErrStore           Refusal = "secret_store_unavailable"
	ErrCreateUncertain Refusal = "secret_create_outcome_unknown"
	ErrMissing         Refusal = "secret_not_found"
	ErrIntegrity       Refusal = "credential_integrity_failed"
	ErrUnsupported     Refusal = "provider_route_unavailable"
	ErrProvider        Refusal = "provider_operation_failed"
)

func safeCode(err error) string {
	var refusal Refusal
	if errors.As(err, &refusal) {
		return string(refusal)
	}
	return "operation_failed"
}
