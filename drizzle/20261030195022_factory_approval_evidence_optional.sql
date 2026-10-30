-- Expand #492: stop persisting evidence digests; retain old columns and receipts
-- until all deployed readers/writers have switched to candidate-only approval.
ALTER TABLE factory_approvals ALTER COLUMN "evidenceDigest" DROP NOT NULL;
