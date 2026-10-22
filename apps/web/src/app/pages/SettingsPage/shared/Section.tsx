import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import styles from "./Section.module.css";

/**
 * The full-width shell every settings group sits in: heading, blurb, controls.
 * Leave out `title` when something above already names the group, such as the
 * bottom sheet header a tab opens in on phones.
 */
export function Section({
  title,
  description,
  className,
  children,
}: {
  title?: string;
  className?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={cn(styles.section, className)}>
      {title && <h3 className={styles.heading}>{title}</h3>}
      {description && <p className={styles.description}>{description}</p>}
      {children}
    </section>
  );
}
