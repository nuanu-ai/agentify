-- A link an operator asks for from the workspace to confirm an action is
-- counted apart from the public form's, so typing an operator's address there
-- cannot spend the links the operator needs.
ALTER TABLE "dashboard_link_sends" DROP CONSTRAINT "dashboard_link_sends_purpose";--> statement-breakpoint
ALTER TABLE "dashboard_link_sends" ADD CONSTRAINT "dashboard_link_sends_purpose" CHECK ("dashboard_link_sends"."purpose" in ('dashboard', 'report', 'step-up'));