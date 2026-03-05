CREATE TABLE "page_shares" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"pageId" varchar(30) NOT NULL,
	"userId" varchar(30) NOT NULL,
	"sharedBy" varchar(30) NOT NULL,
	"permission" varchar(20) NOT NULL,
	"includeChildren" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "page_shares_pageId_userId_unique" UNIQUE("pageId","userId")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"userId" varchar(30) NOT NULL,
	"tokenHash" varchar(64) NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"spaceId" varchar(30) NOT NULL,
	"userId" varchar(30) NOT NULL,
	"role" varchar(20) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_spaceId_userId_unique" UNIQUE("spaceId","userId")
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(20) NOT NULL,
	"ownerId" varchar(30) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"passwordHash" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "userId" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "spaceId" varchar(30) NOT NULL;