package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

type enrollmentReadError struct {
	SecretStore
	err error
}

func (s enrollmentReadError) Read(context.Context, string) ([]byte, error) { return nil, s.err }

func TestEnrollmentSourceDenialSurvivesOpaqueStatusAndProofBoundaries(t *testing.T) {
	ctx := context.Background()
	for _, sourceErr := range []error{ErrSourceStoreDenied, fmt.Errorf("fixture wrapped error: %w", ErrSourceStoreDenied)} {
		for _, kind := range []string{"receipt", "grant", "proof"} {
			t.Run(kind, func(t *testing.T) {
				e, o, _, _, _ := enrollmentFixture()
				_ = o
				principal := "operator:fixture-principal"
				start, err := e.Start(ctx, principal)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = e.Complete(ctx, principal, start.ID, enrollmentCallback(start)); err != nil {
					t.Fatal(err)
				}
				switch kind {
				case "receipt":
					e.Claims = enrollmentReadError{e.Claims, sourceErr}
				case "grant":
					e.Grants = enrollmentReadError{e.Grants, sourceErr}
				case "proof":
					e.Claims = enrollmentReadError{e.Claims, sourceErr}
					if err = verifyEnrollmentClaim(ctx, e, enrollmentTransfer{EnrollmentID: start.ID}); err != ErrSourceStoreDenied {
						t.Fatal("proof lost typed denial", err)
					}
					return
				}
				if _, err = e.Status(ctx, principal, start.ID); err != ErrSourceStoreDenied {
					t.Fatal("status lost typed denial", err)
				}
			})
		}
	}
}
func TestEnrollmentNonDenialFailuresRemainOpaque(t *testing.T) {
	e, _, _, _, _ := enrollmentFixture()
	ctx := context.Background()
	principal := "operator:fixture-principal"
	start, err := e.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.Complete(ctx, principal, start.ID, enrollmentCallback(start)); err != nil {
		t.Fatal(err)
	}
	original := e.Claims
	for _, failure := range []error{ErrMissing, ErrStore, fmt.Errorf("fixture private diagnostic")} {
		e.Claims = enrollmentReadError{original, failure}
		if _, err = e.Status(ctx, principal, start.ID); err != ErrUnavailable {
			t.Fatal("status exposed non-denial", err)
		}
		if err = verifyEnrollmentClaim(ctx, e, enrollmentTransfer{EnrollmentID: start.ID}); err != ErrStale {
			t.Fatal("proof exposed non-denial", err)
		}
	}
	e.Claims = original
	tfr := enrollmentTransfer{EnrollmentID: start.ID}
	raw, _ := json.Marshal(tfr)
	if err = e.Claims.Create(ctx, bindingClaimName(start.ID), raw); err != nil {
		t.Fatal(err)
	}
	if err = verifyEnrollmentClaim(ctx, e, tfr); err != nil {
		t.Fatal("matching proof rejected", err)
	}
	tfr.Subject = "different"
	if err = verifyEnrollmentClaim(ctx, e, tfr); err != ErrStale {
		t.Fatal("mismatched proof accepted", err)
	}
}
