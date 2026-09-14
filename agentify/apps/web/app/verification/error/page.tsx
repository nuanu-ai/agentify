import { SystemMessagePage } from "../../../components/system-message-page";

export default function VerificationErrorPage() {
  return (
    <SystemMessagePage
      actionLabel="Start or reopen a scan"
      description="The link is invalid, expired, or already used. Return to the private scan in the original browser to request another link."
      title="Verification link unavailable"
    />
  );
}
