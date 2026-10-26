import { SystemMessagePage } from "./system-message-page";

/** What the page for an address the scanner has no page for is called, in its heading and its head. */
export const NOT_FOUND_TITLE = "Page not found";

/** Any address the scanner has no page for, answered with status 404. */
export function NotFoundPage() {
  return (
    <SystemMessagePage
      actionLabel="Start a scan"
      description="There is no page at this address. It may have moved or expired."
      title={NOT_FOUND_TITLE}
    />
  );
}
