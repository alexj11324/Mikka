package worker

import (
	"errors"
	"net/http"
)

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
	ErrReauthenticate  Refusal = "reconnect_required"
	ErrAccessDenied    Refusal = "provider_access_denied"
	ErrRateLimited     Refusal = "subscription_rate_limited"
	ErrRequestRejected Refusal = "provider_request_rejected"
	ErrTemporary       Refusal = "provider_temporarily_unavailable"
)

// HTTP status identifies a recovery without exporting provider text. A 403
// may reject a model or permission; it does not prove the token has expired.
func providerStatusFailure(status int) Refusal {
	switch status {
	case http.StatusUnauthorized:
		return ErrReauthenticate
	case http.StatusForbidden:
		return ErrAccessDenied
	case http.StatusTooManyRequests:
		return ErrRateLimited
	case http.StatusBadRequest, http.StatusNotFound, http.StatusUnprocessableEntity:
		return ErrRequestRejected
	}
	if status >= 500 && status <= 599 {
		return ErrTemporary
	}
	return ErrProvider
}

// Only provider-documented enum values affect recovery. Unknown fields never
// become refusal codes, even when they look like an enum.
func providerEventFailure(kind string) Refusal {
	switch kind {
	case "authentication_error", "invalid_api_key", "invalid_authentication", "token_expired":
		return ErrReauthenticate
	case "permission_error", "permission_denied", "insufficient_permissions":
		return ErrAccessDenied
	case "rate_limit_error", "rate_limit_exceeded":
		return ErrRateLimited
	case "invalid_request_error", "not_found_error", "model_not_found":
		return ErrRequestRejected
	case "overloaded_error", "api_error", "server_error":
		return ErrTemporary
	}
	return ErrProvider
}

// The executor is replaceable. Preserve only our known public refusals rather
// than trusting an arbitrary executor error's text or Refusal value.
func executionFailure(err error) Refusal {
	for _, known := range []Refusal{ErrReauthenticate, ErrAccessDenied, ErrRateLimited, ErrRequestRejected, ErrTemporary, ErrUnsupported, ErrCredential} {
		if errors.Is(err, known) {
			return known
		}
	}
	return ErrProvider
}

func safeCode(err error) string {
	var refusal Refusal
	if errors.As(err, &refusal) {
		return string(refusal)
	}
	return "operation_failed"
}
