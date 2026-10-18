import { PrivacyChoicesButton } from "@agentify/consent";
import type { PublicResultPreview } from "../lib/share-copy";
import styles from "./public-share-page.module.css";
import { ResultHead } from "./result-head";
import layout from "./result-layout.module.css";
import { SiteTop } from "./site-chrome";
import { SiteLink } from "./site-link";
import { UrlScanForm } from "./url-scan-form";

/** A published result at its public link, with the way to scan one's own site under it. */
export function PublicSharePage({ preview }: Readonly<{ preview: PublicResultPreview }>) {
  return (
    <div className={layout.page}>
      <SiteTop end={<span className={layout.quiet}>Public result</span>} />
      <main className={layout.body}>
        <div className={`${layout.sheet} ${layout.single}`}>
          <section aria-label="Public result">
            <ResultHead
              host={preview.hostLabel}
              level={preview.level}
              line={preview.scannedLabel}
              score={preview.score}
            />
            <p className={styles.disclosure}>
              Only the domain, level, score, scale and scan date are public. Detailed findings and
              contact details stay private.
            </p>
          </section>
          <section className={styles.cta}>
            <h2>Curious how your own site reads?</h2>
            <p>Run the same scan — no login or plugin.</p>
            <UrlScanForm compact cta="Scan" segment="owner" variant="share-result-v1" />
          </section>
        </div>
      </main>
      <footer>
        <nav aria-label="Public result information" className={layout.foot}>
          <a href="/docs/scanner/methodology">Methodology</a>
          <SiteLink to="/privacy">Privacy</SiteLink>
          <PrivacyChoicesButton />
        </nav>
      </footer>
    </div>
  );
}
