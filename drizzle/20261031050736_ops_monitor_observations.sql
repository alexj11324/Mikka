-- target: MIKKA_DATABASE_URL
-- Global aggregate operational signals, no bodies, tenant identities or secret references.
CREATE TABLE ops_monitor_observations (
 id uuid PRIMARY KEY,
 "observedAt" timestamptz NOT NULL DEFAULT now(),
 signals jsonb NOT NULL,
 alerts jsonb NOT NULL,
 transitions jsonb NOT NULL,
 state jsonb NOT NULL,
 "notificationStatus" text NOT NULL CHECK ("notificationStatus" IN ('not_configured','delivered','failed'))
);
CREATE INDEX ops_monitor_observations_latest ON ops_monitor_observations("observedAt" DESC,id DESC);
