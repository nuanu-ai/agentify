/**
 * The report's way into the dashboard: an ordinary link, because the session
 * that opened this report is the dashboard's too. It makes nothing: under
 * SameSite=Lax a link from another site arrives signed in, so only the
 * dashboard's own control makes a merchant, and a POST from here would be a
 * request a page elsewhere could forge.
 */
export function ReportDashboardControl() {
  return (
    <a className="button button-primary" href="/dashboard/">
      Open your dashboard
    </a>
  );
}
