ALTER TABLE "agent_runs" ADD COLUMN "failureDetails" jsonb;
--> statement-breakpoint
ALTER TABLE "coordinator_sessions" ADD COLUMN "lastFailure" jsonb;
--> statement-breakpoint
ALTER TABLE "native_coordinator_turns" ADD COLUMN "failureDetails" jsonb;
