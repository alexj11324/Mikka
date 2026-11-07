package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

type cacheProbeTransport func(*http.Request) (*http.Response, error)

func (f cacheProbeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func cacheProbeHash(t *testing.T, value any) string {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(b)
	return hex.EncodeToString(digest[:])
}

// The fixture is the actual compatible SDK 3.0.75 output of three synthetic
// growing turns. Its efb layout source is byte-identical to the candidate base.
// Exercise the public adapter and pinned CPA converter without network access.
func TestCodexSubscriptionGrowingHistoryEligiblePrefixes(t *testing.T) {
	raw, err := os.ReadFile("testdata/codex-growing-history-sdk.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		SourceCommit string `json:"sourceCommit"`
		SDKVersion   string `json:"sdkVersion"`
		Synthetic    bool   `json:"syntheticOnly"`
		Requests     []struct {
			Turn    int             `json:"turn"`
			Payload json.RawMessage `json:"payload"`
		} `json:"requests"`
	}
	if json.Unmarshal(raw, &fixture) != nil || fixture.SourceCommit != "efb95d951ddbeca1af04bc80d011ccbc2a9f0188" || fixture.SDKVersion != "3.0.75" || !fixture.Synthetic || len(fixture.Requests) != 3 {
		t.Fatal("synthetic fixture provenance or shape invalid")
	}
	var rows []map[string]any
	var previous []any
	previousEnd := -1
	var previousOptions string
	for index, source := range fixture.Requests {
		if source.Turn != index+1 {
			t.Fatal("synthetic turn order invalid")
		}
		var body map[string]any
		transportCalls := 0
		model := CPAPlainModel{Provider: "codex", Client: &http.Client{Transport: cacheProbeTransport(func(request *http.Request) (*http.Response, error) {
			transportCalls++
			if request.URL.String() != "https://chatgpt.com/backend-api/codex/responses" || request.Header.Get("Originator") != "Mikka" || request.Header.Get("User-Agent") != "Mikka/1.0" || request.Header.Get("ChatGPT-Account-Id") != "synthetic-account" || request.Header.Get("Authorization") != "Bearer synthetic-not-a-credential" {
				t.Fatal("unexpected synthetic provider boundary")
			}
			if request.Header.Get("Session-Id") != "" || request.Header.Get("X-Codex-Turn-State") != "" {
				t.Fatal("probe unexpectedly changed session or turn routing")
			}
			if json.NewDecoder(request.Body).Decode(&body) != nil {
				t.Fatal("invalid actual CPA outgoing JSON")
			}
			terminal := "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"synthetic-response\",\"model\":\"gpt-6-luna\",\"output\":[],\"usage\":{\"input_tokens\":4096,\"output_tokens\":1}}}\n\n"
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(terminal))}, nil
		})}}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		saved := append([]byte(nil), source.Payload...)
		stream, err := model.ExecuteStream(ctx, &core.Auth{Metadata: map[string]any{"access_token": "synthetic-not-a-credential", "account_id": "synthetic-account"}}, ex.Request{Model: "gpt-6-luna", Payload: source.Payload}, ex.Options{})
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		for chunk := range stream.Chunks {
			if chunk.Err != nil {
				cancel()
				t.Fatal(chunk.Err)
			}
		}
		cancel()
		if transportCalls != 1 || !bytes.Equal(source.Payload, saved) {
			t.Fatal("transport count or source mutation")
		}
		input, ok := body["input"].([]any)
		if !ok || len(input) != 4+2*index || body["instructions"] != "" || body["model"] != "gpt-6-luna" || body["parallel_tool_calls"] != true || objectMap(body["reasoning"])["effort"] != "medium" {
			t.Fatal("actual CPA request options or input layout invalid")
		}
		roles := make([]string, len(input))
		latestUser := -1
		for i, item := range input {
			roles[i], _ = objectMap(item)["role"].(string)
			if roles[i] == "user" {
				latestUser = i
			}
		}
		if roles[0] != "developer" || roles[1] != "developer" || roles[len(roles)-1] != "developer" || latestUser != len(input)-2 {
			t.Fatal("initial developer block or final eligible user boundary changed")
		}
		for _, key := range []string{"prompt_cache_key", "prompt_cache_options", "session_id", "metadata"} {
			if _, exists := body[key]; exists {
				t.Fatal("probe unexpectedly introduced an outbound field")
			}
		}
		options := make(map[string]any, len(body))
		for key, value := range body {
			if key != "input" {
				options[key] = value
			}
		}
		optionsHash := cacheProbeHash(t, options)
		var previousMatches any
		if previous != nil {
			previousMatches = cacheProbeHash(t, input[:previousEnd+1]) == cacheProbeHash(t, previous[:previousEnd+1])
			if previousMatches != true || optionsHash != previousOptions {
				t.Fatal("prior eligible user prefix or cache-relevant request options changed")
			}
		}
		rows = append(rows, map[string]any{"turn": index + 1, "roles": roles, "inputItems": len(input), "latestEligibleUserIndex": latestUser, "initialDeveloperPrefixHash": cacheProbeHash(t, input[:2]), "latestEligiblePrefixHash": cacheProbeHash(t, input[:latestUser+1]), "previousEligiblePrefixStillMatches": previousMatches, "requestOptionsHash": optionsHash, "networkRequests": 0, "injectedTransportCalls": transportCalls})
		previous = input
		previousEnd = latestUser
		previousOptions = optionsHash
	}
	report, err := json.MarshalIndent(map[string]any{"sourceCommit": fixture.SourceCommit, "syntheticOnly": true, "networkRequests": 0, "rows": rows}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}

	t.Log(string(report))
}
