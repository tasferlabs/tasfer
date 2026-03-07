CREATE TABLE "sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"userId" varchar(30) NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "refresh_tokens" CASCADE;