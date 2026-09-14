import Link from "next/link";

import { Brand } from "./brand";
import styles from "./system-message-page.module.css";

export function SystemMessagePage({
  actionLabel,
  description,
  href = "/owner",
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
        <Link className="button button-primary" href={href}>
          {actionLabel}
        </Link>
      </section>
    </main>
  );
}
