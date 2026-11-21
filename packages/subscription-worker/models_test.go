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
				body := `{"models":[{"slug":"account-model","display_name":" Account model ","visibility":"list","secret":"must-not-leak","service_tiers":[{"id":"priority","description":"tier-private"}],"additional_speed_tiers":["fast"]},{"slug":"account-model","display_name":"Duplicate"},{"slug":"hidden-model","visibility":"hide"},{"slug":"bad id"},{"slug":"legacy-model","display_name":"Legacy model","additional_speed_tiers":["fast"]},{"slug":"no-priority","display_name":"","service_tiers":[]}]}`
				if provider == "claude" {
					if r.URL.Host != "api.anthropic.com" || r.URL.Path != "/v1/models" || r.Header.Get("anthropic-beta") == "" {
						t.Fatal("wrong Claude endpoint")
					}
					body = `{"data":[{"id":"account-model","display_name":"Account model","secret":"must-not-leak","service_tiers":[{"id":"priority"}],"additional_speed_tiers":["fast"]},{"id":"account-model","display_name":"Duplicate"},{"id":"bad id"}]}`
				} else if r.URL.Host != "chatgpt.com" || r.URL.Path != "/backend-api/codex/models" || r.URL.Query().Get("client_version") != "0.167.0" {
					t.Fatal("wrong Codex endpoint")
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
			})}
			if _, err := w.Models(context.Background(), initial.Revision); err != ErrUnsupported {
				t.Fatal("bound execution could enumerate owner catalogue")
			}
			w.Use = nil
			models, err := w.Models(context.Background(), initial.Revision)
			wantCount := 1
			if provider == "codex" {
				wantCount = 3
			}
			if err != nil || len(models) != wantCount || models[0].ID != "account-model" || models[0].Name != "Account model" {
				t.Fatalf("catalogue projection failed: %v %v", models, err)
			}
			if provider == "codex" {
				if models[0].PrioritySupported == nil || !*models[0].PrioritySupported {
					t.Fatal("advertised Codex priority was not projected")
				}
				if models[1].ID != "legacy-model" || models[1].PrioritySupported != nil {
					t.Fatal("legacy speed tiers became proof of priority")
				}
				if models[2].ID != "no-priority" || models[2].Name != "no-priority" || models[2].PrioritySupported == nil || *models[2].PrioritySupported {
					t.Fatal("name sanitization lost explicit priority absence")
				}
			} else if models[0].PrioritySupported != nil {
				t.Fatal("Claude acquired a Codex priority capability")
			}
			raw, _ := json.Marshal(models)
			for _, field := range []string{"must-not-leak", "tier-private", "service_tiers", "additional_speed_tiers"} {
				if bytes.Contains(raw, []byte(field)) {
					t.Fatal("raw provider field crossed worker boundary")
				}
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
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"models":[{"slug":"model","display_name":"Model","service_tiers":[{"id":"priority"}]}]}`)), Header: make(http.Header)}, nil
	})}
	if _, err := w.Models(context.Background(), initial.Revision); err != ErrUnavailable {
		t.Fatal("disconnect did not revoke catalogue read")
	}
}

func TestModelOptionPriorityJSON(t *testing.T) {
	for _, tc := range []struct {
		name    string
		raw     string
		want    string
		invalid bool
	}{
		{"missing", `{"id":"fixture-model","name":"Fixture model"}`, `{"id":"fixture-model","name":"Fixture model"}`, false},
		{"advertised", `{"id":"fixture-model","name":"Fixture model","prioritySupported":true}`, `{"id":"fixture-model","name":"Fixture model","prioritySupported":true}`, false},
		{"not advertised", `{"id":"fixture-model","name":"Fixture model","prioritySupported":false}`, `{"id":"fixture-model","name":"Fixture model","prioritySupported":false}`, false},
		{"unknown", `{"id":"fixture-model","name":"Fixture model","prioritySupported":null}`, `{"id":"fixture-model","name":"Fixture model"}`, false},
		{"not a boolean", `{"id":"fixture-model","name":"Fixture model","prioritySupported":"true"}`, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var option ModelOption
			err := json.Unmarshal([]byte(tc.raw), &option)
			if tc.invalid {
				if err == nil {
					t.Fatal("non-boolean priority capability accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(option)
			if err != nil || string(raw) != tc.want {
				t.Fatalf("capability wire projection = %s, %v; want %s", raw, err, tc.want)
			}
		})
	}
}

func TestCodexPrioritySupportedRequiresAdvertisedTier(t *testing.T) {
	for _, tc := range []struct {
		name  string
		tiers string
		want  string
	}{
		{"missing", "", ""},
		{"null", "null", ""},
		{"empty array", "[]", "false"},
		{"another tier", `[{"id":"standard"}]`, "false"},
		{"priority", `[{"id":"priority","name":"Fast","description":"provider-only"}]`, "true"},
		{"priority among tiers", `[{"id":"standard"},{"id":"priority"},{"id":"flex"}]`, "true"},
		{"legacy fast is not priority", `[{"id":"fast"}]`, "false"},
		{"case must match", `[{"id":"Priority"}]`, "false"},
		{"no value coercion", `[{"id":" priority "}]`, "false"},
		{"string is not an array", `"priority"`, ""},
		{"object is not an array", `{"id":"priority"}`, ""},
		{"boolean is not an array", "true", ""},
		{"null entry", "[null]", ""},
		{"string entry", `["priority"]`, ""},
		{"missing id", `[{"name":"priority"}]`, ""},
		{"wrong id key", `[{"ID":"priority"}]`, ""},
		{"null id", `[{"id":null}]`, ""},
		{"numeric id", `[{"id":1}]`, ""},
		{"empty id", `[{"id":""}]`, ""},
		{"malformed after priority", `[{"id":"priority"},null]`, ""},
		{"malformed before priority", `[{"name":"Fast"},{"id":"priority"}]`, ""},
		{"invalid JSON", `[{"id":"priority"}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			supported := codexPrioritySupported(json.RawMessage(tc.tiers))
			if tc.want == "" {
				if supported != nil {
					t.Fatalf("unknown capability became %v", *supported)
				}
				return
			}
			if supported == nil || *supported != (tc.want == "true") {
				t.Fatalf("priority capability = %v; want %s", supported, tc.want)
			}
		})
	}
}
