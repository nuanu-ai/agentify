import { Brand } from "./brand";
import { SiteLink } from "./site-link";
import styles from "./system-message-page.module.css";

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
    <main className={`${styles.page} container`}>
      <Brand />
      <section className={styles.card}>
        <h1>{title}</h1>
        <p>{description}</p>
        <SiteLink className="button button-primary" to={href}>
          {actionLabel}
        </SiteLink>
      </section>
    </main>
  );
}
