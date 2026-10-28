-- Proposal only: not registered in drizzle and not approved for production apply.
CREATE TABLE factory_monitor_incidents (
 id uuid PRIMARY KEY, owner_id text NOT NULL, workspace_key text NOT NULL,
 fingerprint text NOT NULL, check_key text NOT NULL, issue_id text NOT NULL,
 occurrences integer NOT NULL DEFAULT 0,
 status text NOT NULL CHECK (status IN ('open','recovery_observed')),
 UNIQUE(owner_id,workspace_key,fingerprint)
);
CREATE TABLE factory_monitor_observations (
 owner_id text NOT NULL, event_id text NOT NULL, payload_hash text NOT NULL,
 incident_id uuid NOT NULL REFERENCES factory_monitor_incidents(id),
 identity jsonb NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('unhealthy','healthy')),
 PRIMARY KEY(owner_id,event_id)
);
