package worker

import (
	"io"
	"net/http"
	"time"
)

// Ordinary TLS, fixed destinations, honest identity, bounded responses. This
// replaces neither provider limits nor authorization and performs no retries.
type oauthTransport struct{ base http.RoundTripper }

func (t oauthTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	switch request.URL.String() {
	case "https://auth.openai.com/api/accounts/deviceauth/usercode", "https://auth.openai.com/api/accounts/deviceauth/token", "https://auth.openai.com/oauth/token", "https://platform.claude.com/v1/oauth/token", "https://api.anthropic.com/api/oauth/profile":
	default:
		return nil, ErrUnsupported
	}
	clone := request.Clone(request.Context())
	clone.Header = make(http.Header)
	for _, key := range []string{"Content-Type", "Accept", "Authorization"} {
		if value := request.Header.Get(key); value != "" {
			clone.Header.Set(key, value)
		}
	}
	clone.Header.Set("User-Agent", "Mikka/1.0")
	clone.Close = false
	response, err := t.base.RoundTrip(clone)
	if err != nil {
		return nil, ErrProvider
	}
	response.Body = struct {
		io.Reader
		io.Closer
	}{io.LimitReader(response.Body, 262145), response.Body}
	return response, nil
}
func plainOAuthClient(input *http.Client) *http.Client {
	client := http.Client{Timeout: 15 * time.Second}
	if input != nil {
		client = *input
	}
	base := client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	client.Transport = oauthTransport{base}
	client.Timeout = 15 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &client
}
