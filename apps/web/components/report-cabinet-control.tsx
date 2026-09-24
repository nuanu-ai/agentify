/**
 * The report's way into the cabinet: an ordinary link.
 *
 * The session that opened this report is the cabinet's too (ADR-0026 §2), so
 * the link needs nothing but itself. It makes nothing: under Lax a link from
 * another site arrives signed in, so the merchant is made only by the one
 * control the cabinet offers, and a POST from here would be a request a page
 * elsewhere could forge (§4).
 */
export function ReportCabinetControl() {
  return (
    <a className="button button-primary" href="/cabinet/">
      Open your cabinet
    </a>
  );
}
