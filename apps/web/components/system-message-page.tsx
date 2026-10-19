import { SiteFooter, SiteHeader } from "./site-chrome";
import { SiteLink } from "./site-link";
import styles from "./system-message-page.module.css";

/** A page that says something went other than asked, under the site's header and over its footer. */
export function SystemMessagePage({
  actionLabel,
  description,
  href = "/",
  title,
}: Readonly<{
  actionLabel: string;
  description: string;
  href?: string;
  title: string;
}>) {
  return (
    <>
      <SiteHeader />
      <main className={`${styles.page} container`} id="main">
        <section className={styles.card}>
          <h1>{title}</h1>
          <p>{description}</p>
          <SiteLink className="button button-primary" to={href}>
            {actionLabel}
          </SiteLink>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
