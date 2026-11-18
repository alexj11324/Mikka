package worker

import (
	"context"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const subscriptionAuthorityChannel = "mikka_subscription_authority_v1"

var neonDirectHost = regexp.MustCompile(`^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$`)

// authorityListenerConfig uses a direct Neon endpoint for LISTEN. Other
// configured PostgreSQL endpoints are used unchanged; failure to establish a
// session leaves the caller on its existing SQL authorization fallback.
func authorityListenerConfig(raw string) (*pgx.ConnConfig, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		return nil, ErrDatabase
	}
	host := parsed.Hostname()
	if strings.HasSuffix(host, ".neon.tech") {
		if !neonDirectHost.MatchString(host) {
			return nil, ErrDatabase
		}
		first, rest, ok := strings.Cut(host, ".")
		if !ok {
			return nil, ErrDatabase
		}
		host = strings.TrimSuffix(first, "-pooler") + "." + rest
		if port := parsed.Port(); port != "" {
			parsed.Host = net.JoinHostPort(host, port)
		} else {
			parsed.Host = host
		}
	}
	cfg, err := pgx.ParseConfig(parsed.String())
	if err != nil {
		return nil, ErrDatabase
	}
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = make(map[string]string)
	}
	cfg.RuntimeParams["application_name"] = "mikka-subscription-authority-listener"
	cfg.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		dialer := net.Dialer{KeepAlive: 5 * time.Second, KeepAliveConfig: net.KeepAliveConfig{Enable: true, Idle: 5 * time.Second, Interval: 2 * time.Second, Count: 3}}
		return dialer.DialContext(ctx, network, address)
	}
	return cfg, nil
}

func authorityNotificationMatches(payload string, connectionID, bindingID, runID string) bool {
	return payload == "connection:"+connectionID ||
		payload == "binding:"+bindingID ||
		runID != "" && payload == "run:"+runID
}

func runLeaseExpiryContext(expiry time.Time, cancel context.CancelFunc) func() {
	timer := time.AfterFunc(time.Until(expiry), cancel)
	return func() { timer.Stop() }
}

// watchActiveAuthority installs LISTEN before the caller's fresh authorization
// query, closing the read/subscribe race. Any relevant committed change or
// listener loss cancels the active stream. A subsequent RPC does a new DB
// authorization read; notifications are intentionally not replayed.
func (w *Worker) watchActiveAuthority(parent context.Context) (context.Context, func(), bool) {
	if w.DatabaseURL == "" || w.Use == nil {
		return parent, func() {}, false
	}
	cfg, err := authorityListenerConfig(w.DatabaseURL)
	if err != nil {
		return parent, func() {}, false
	}
	connectCtx, cancelConnect := context.WithTimeout(parent, 5*time.Second)
	conn, err := pgx.ConnectConfig(connectCtx, cfg)
	cancelConnect()
	if err != nil {
		return parent, func() {}, false
	}
	listenCtx, cancel := context.WithCancel(parent)
	if _, err = conn.Exec(listenCtx, "LISTEN "+subscriptionAuthorityChannel); err != nil {
		cancel()
		_ = conn.Close(context.Background())
		return parent, func() {}, false
	}
	var stopLeaseTimer func()
	if w.Use.RunID != "" {
		// Leases expire without a row update, so the database cannot emit a
		// NOTIFY at the expiry instant. Arm a local deadline from a scoped read;
		// if it cannot be read, retain the old periodic authorization checks.
		readCtx, readCancel := context.WithTimeout(parent, 2*time.Second)
		var expiresAt time.Time
		err = w.Repo.DB.QueryRowContext(readCtx, `select r."leaseExpiresAt" from agent_runs r join byos_native_runs n on n."runId"=r.id join byos_bindings b on b.id=n."bindingId" where r.id=$1 and r."userId"=$2 and r."agentId"::text=$3 and n."bindingId"=$4 and r.status in ('preparing','running','waiting_input') and r."leaseExpiresAt">now() and r."stopRequestedAt" is null`, w.Use.RunID, w.Scope.OwnerID, w.Use.ConsumerID, w.Use.BindingID).Scan(&expiresAt)
		readCancel()
		if err != nil {
			cancel()
			_ = conn.Close(context.Background())
			return parent, func() {}, false
		}
		stopLeaseTimer = runLeaseExpiryContext(expiresAt, cancel)
	}
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		for {
			notification, waitErr := conn.WaitForNotification(listenCtx)
			if waitErr != nil {
				if listenCtx.Err() == nil {
					cancel() // fail closed on listener loss
				}
				return
			}
			if notification != nil && authorityNotificationMatches(notification.Payload, w.Scope.ConnectionID, w.Use.BindingID, w.Use.RunID) {
				cancel()
				return
			}
		}
	}()
	stop := func() {
		if stopLeaseTimer != nil {
			stopLeaseTimer()
		}
		cancel()
		// WaitForNotification owns the pgx connection while it is blocked.
		// Cancel its context and join the listener before closing the connection;
		// closing concurrently races pgx's receive loop.
		<-closed
		_ = conn.Close(context.Background())
	}
	return listenCtx, stop, true
}
