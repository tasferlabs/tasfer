import type { ReactNode } from "react";
import styles from "./Section.module.css";

/** The full-width shell every settings group sits in: heading, blurb, controls. */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{title}</h3>
      {description && <p className={styles.description}>{description}</p>}
      {children}
    </section>
  );
}
