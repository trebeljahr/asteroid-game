CREATE TABLE "match_leases" (
	"match_id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"owner_replica" text NOT NULL,
	"epoch" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_snapshots" (
	"match_id" text PRIMARY KEY NOT NULL,
	"epoch" bigint NOT NULL,
	"sequence" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matchmaking_tickets" (
	"socket_id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"replica_id" text NOT NULL,
	"user_id" uuid,
	"ship_variant" text NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "match_leases_state_expires_idx" ON "match_leases" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "matchmaking_tickets_mode_enqueued_idx" ON "matchmaking_tickets" USING btree ("mode","enqueued_at");