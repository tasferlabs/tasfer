CREATE TABLE "images" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"fileName" text NOT NULL,
	"filePath" text NOT NULL,
	"mimeType" text NOT NULL,
	"size" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"title" text,
	"autoTitle" boolean DEFAULT true NOT NULL,
	"parentId" varchar(30),
	"order" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"pageId" varchar(30) NOT NULL,
	"filePath" text NOT NULL,
	"size" integer NOT NULL,
	"clockWall" bigint,
	"clockLogical" integer,
	"clockPeerId" varchar(16),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
