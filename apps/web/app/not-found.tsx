import { SystemMessagePage } from "../components/system-message-page";

export default function NotFoundPage() {
  return (
    <SystemMessagePage
      actionLabel="Start a scan"
      description="The page may have moved, expired, or never been published."
      title="Page not found"
    />
  );
}
