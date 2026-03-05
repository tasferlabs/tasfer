ALTER TABLE "users" ADD COLUMN "emailVerified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "verificationCode" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "verificationCodeExpiresAt" timestamp;