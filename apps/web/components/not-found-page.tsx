import { SystemMessagePage } from "./system-message-page";

/** What the page for an address the scanner has no page for is called, in its heading and its head. */
export const NOT_FOUND_TITLE = "Page not found";

/** Any address the scanner has no page for, answered with status 404. */
export function NotFoundPage() {
  return (
    <SystemMessagePage
      actionLabel="Start a scan"
      description="The page may have moved, expired, or never been published."
      title={NOT_FOUND_TITLE}
    />
  );
}
