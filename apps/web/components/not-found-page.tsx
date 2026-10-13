import { SystemMessagePage } from "./system-message-page";

/** Any address the scanner has no page for, answered with status 404. */
export function NotFoundPage() {
  return (
    <SystemMessagePage
      actionLabel="Start a scan"
      description="The page may have moved, expired, or never been published."
      title="Page not found"
    />
  );
}
