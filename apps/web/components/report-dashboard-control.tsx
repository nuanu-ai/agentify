/**
 * The report's way into the dashboard: an ordinary link.
 *
 * The session that opened this report is the dashboard's too (ADR-0026 §2), so
 * the link needs nothing but itself. It makes nothing: under Lax a link from
 * another site arrives signed in, so the merchant is made only by the one
 * control the dashboard offers, and a POST from here would be a request a page
 * elsewhere could forge (§4).
 */
export function ReportDashboardControl() {
  return (
    <a className="button button-primary" href="/dashboard/">
      Open your dashboard
    </a>
  );
}
