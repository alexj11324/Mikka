package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestModelsReadsOnlyBoundOwnerCatalogue(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			w, _, _ := fixtureWorker(t, provider)
			initial := mustAcquire(t, w)
			requests := 0
			w.ModelsClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				requests++
				if r.Method != "GET" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
					t.Fatal("missing read authorization")
				}
				body := `{"models":[{"slug":"account-model","display_name":"Account model","visibility":"list","secret":"must-not-leak"},{"slug":"account-model","display_name":"Duplicate"},{"slug":"hidden-model","visibility":"hide"},{"slug":"bad id"}]}`
				if provider == "claude" {
					if r.URL.Host != "api.anthropic.com" || r.URL.Path != "/v1/models" || r.Header.Get("anthropic-beta") == "" {
						t.Fatal("wrong Claude endpoint")
					}
					body = `{"data":[{"id":"account-model","display_name":"Account model","secret":"must-not-leak"},{"id":"account-model","display_name":"Duplicate"},{"id":"bad id"}]}`
				} else if r.URL.Host != "chatgpt.com" || r.URL.Path != "/backend-api/codex/models" || r.URL.Query().Get("client_version") == "" {
					t.Fatal("wrong Codex endpoint")
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
			})}
			if _, err := w.Models(context.Background(), initial.Revision); err != ErrUnsupported {
				t.Fatal("bound execution could enumerate owner catalogue")
			}
			w.Use = nil
			models, err := w.Models(context.Background(), initial.Revision)
			if err != nil || len(models) != 1 || models[0].ID != "account-model" || models[0].Name != "Account model" {
				t.Fatalf("catalogue projection failed: %v %v", models, err)
			}
			raw, _ := json.Marshal(models)
			if bytes.Contains(raw, []byte("must-not-leak")) {
				t.Fatal("raw provider field crossed worker boundary")
			}
			if _, err := w.Models(context.Background(), initial.Revision+1); err == nil {
				t.Fatal("stale catalogue accepted")
			}
			w.ExecutionOnly = true
			if _, err := w.Models(context.Background(), initial.Revision); err != ErrUnsupported {
				t.Fatal("execution child read catalogue")
			}
			if requests != 1 {
				t.Fatal("refused requests reached provider")
			}
		})
	}
}

func TestModelsRefusesProviderErrorsAndPaginates(t *testing.T) {
	w, _, _ := fixtureWorker(t, "claude")
	initial := mustAcquire(t, w)
	w.Use = nil
	requests := 0
	w.ModelsClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requests++
		body := `{"data":[{"id":"first-model","display_name":"First"}],"has_more":true,"last_id":"first-model"}`
		if requests == 2 {
			if r.URL.Query().Get("after_id") != "first-model" {
				t.Fatal("pagination cursor lost")
			}
			body = `{"data":[{"id":"second-model","display_name":"Second"}],"has_more":false}`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	models, err := w.Models(context.Background(), initial.Revision)
	if err != nil || len(models) != 2 || requests != 2 {
		t.Fatal("pagination failed", err)
	}
	for _, body := range []string{`{"error":"provider-secret"}`, `not-json`, `{"data":[],,}`, strings.Repeat("x", 1048577)} {
		w.ModelsClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
		})}
		if _, err := w.Models(context.Background(), initial.Revision); err != ErrProvider {
			t.Fatal("malformed provider body accepted")
		}
	}
	w.ModelsClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 403, Body: io.NopCloser(strings.NewReader("provider-secret")), Header: make(http.Header)}, nil
	})}
	if _, err := w.Models(context.Background(), initial.Revision); err != ErrProvider {
		t.Fatal("provider rejection accepted")
	}
}

func TestModelsDisconnectWinsProviderRead(t *testing.T) {
	w, _, _ := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	w.Use = nil
	w.ModelsClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		if _, err := w.Repo.DB.Exec(`UPDATE byos_connections SET state='disconnected' WHERE id=$1`, w.Scope.ConnectionID); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"models":[{"slug":"model","display_name":"Model"}]}`)), Header: make(http.Header)}, nil
	})}
	if _, err := w.Models(context.Background(), initial.Revision); err != ErrUnavailable {
		t.Fatal("disconnect did not revoke catalogue read")
	}
}
