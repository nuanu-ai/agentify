CREATE TABLE "merchant_contact" (
	"merchant_id" text PRIMARY KEY NOT NULL,
	"polled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_contact" ADD CONSTRAINT "merchant_contact_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;