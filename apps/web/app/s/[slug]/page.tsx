import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Brand } from "../../../components/brand";
import { PrivacyChoicesButton } from "../../../components/privacy-choices-button";
import { PublicResultCard } from "../../../components/public-result-card";
import { UrlScanForm } from "../../../components/url-scan-form";
import { getPublicAppConfig } from "../../../lib/app-config";
import { shareCopy } from "../../../lib/share-copy";
import { getPublicShare } from "../../../lib/server/reporting";
import styles from "./share.module.css";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const { displayBrand } = getPublicAppConfig();
  const share = await getPublicShare(slug);
  if (!share || share.status !== "published")
    return {
      title: "Result unavailable",
      robots: { index: false, follow: false },
    };
  const copy = shareCopy(share.snapshot);
  return {
    title: copy.headline,
    description: copy.subline,
    openGraph: {
      title: copy.headline,
      description: copy.subline,
      siteName: displayBrand,
      type: "website",
      images: [
        {
          url: `/api/v1/shares/${encodeURIComponent(slug)}/image`,
          width: 1200,
          height: 630,
          alt: `${copy.headline} — ${share.snapshot.score}/100 public HTTP diagnostic`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: copy.headline,
      description: copy.subline,
      images: [`/api/v1/shares/${encodeURIComponent(slug)}/image`],
    },
    robots: { index: share.allowIndexing, follow: share.allowIndexing },
  };
}

export default async function PublicSharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const share = await getPublicShare(slug);
  if (!share || share.status !== "published") notFound();
  const snapshot = share.snapshot;
  const scanDate = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(snapshot.generated_at));
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Brand />
        <span>Public result</span>
      </header>
      <main className={styles.main}>
        <span className="eyebrow">Agent-readiness result</span>
        <PublicResultCard
          headingLevel={1}
          preview={{
            hostLabel: snapshot.host,
            level: snapshot.level,
            score: snapshot.score,
            scannedLabel: `Scanned ${scanDate}`,
          }}
        />
        <section className={styles.cta}>
          <h2>Curious how your own site reads?</h2>
          <p>Run the same public HTTP scan — no login or plugin required.</p>
          <UrlScanForm
            compact
            cta="Scan"
            segment="owner"
            variant="share-result-v1"
          />
        </section>
      </main>
      <footer className={styles.footer}>
        <span>
          This page shows only domain, level, score, scale and scan date.
        </span>
        <nav aria-label="Public result information">
          <Link href="/methodology">Methodology</Link>
          <Link href="/privacy">Privacy</Link>
          <PrivacyChoicesButton />
        </nav>
      </footer>
    </div>
  );
}
