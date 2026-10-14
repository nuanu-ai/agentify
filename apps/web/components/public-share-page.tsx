import { Brand } from "./brand";
import { PrivacyChoicesButton } from "./privacy-choices-button";
import { PublicResultCard, type PublicResultPreview } from "./public-result-card";
import styles from "./public-share-page.module.css";
import { SiteLink } from "./site-link";
import { UrlScanForm } from "./url-scan-form";

/** A published result at its public link, with the way to scan one's own site under it. */
export function PublicSharePage({ preview }: Readonly<{ preview: PublicResultPreview }>) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Brand />
        <span>Public result</span>
      </header>
      <main className={styles.main}>
        <PublicResultCard headingLevel={1} preview={preview} />
        <section className={styles.cta}>
          <h2>Curious how your own site reads?</h2>
          <p>Run the same scan — no login or plugin.</p>
          <UrlScanForm compact cta="Scan" segment="owner" variant="share-result-v1" />
        </section>
      </main>
      <footer className={styles.footer}>
        <nav aria-label="Public result information">
          <a href="/docs/scanner/methodology">Methodology</a>
          <SiteLink to="/privacy">Privacy</SiteLink>
          <PrivacyChoicesButton />
        </nav>
      </footer>
    </div>
  );
}
