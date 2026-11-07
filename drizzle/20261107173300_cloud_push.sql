ALTER TABLE cloud_service_registration ADD COLUMN push_content text NOT NULL DEFAULT 'full' CHECK(push_content IN ('full','reminder'));

-- Only encrypted delivery metadata is retained; never notification content.
CREATE TABLE mobile_push_receipts (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider IN ('expo','cloud')),
  secret jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobile_push_receipts_created_at ON mobile_push_receipts(created_at);
