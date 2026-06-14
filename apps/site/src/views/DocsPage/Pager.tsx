"use client";

import { Link } from "@/components/Link";
import { useTranslation } from "react-i18next";
import { FLAT } from "./docsNav";

/** Previous / next links derived from the flat page order. */
export function Pager({ route }: { route: string }) {
  const { t } = useTranslation();
  const idx = FLAT.findIndex((p) => p.route === route);
  const prev = idx > 0 ? FLAT[idx - 1] : null;
  const next = idx >= 0 && idx < FLAT.length - 1 ? FLAT[idx + 1] : null;

  return (
    <nav className="dx-pager">
      {prev ? (
        <Link className="dx-pager-link prev" to={"/docs/" + prev.route}>
          <span className="dx-pager-dir">{t("docs.pager.prev", "← previous")}</span>
          <span className="dx-pager-title">{prev.title}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link className="dx-pager-link next" to={"/docs/" + next.route}>
          <span className="dx-pager-dir">{t("docs.pager.next", "next →")}</span>
          <span className="dx-pager-title">{next.title}</span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
