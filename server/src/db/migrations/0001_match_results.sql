CREATE TABLE "match_results" (
	"match_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_results_match_id_user_id_pk" PRIMARY KEY("match_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;