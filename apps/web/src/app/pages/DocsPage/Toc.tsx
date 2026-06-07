import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

/** Right-rail table of contents with scroll-spy. Re-scans the article's
 *  `h2[id]`/`h3[id]` whenever `route` changes. */
export function Toc({ route }: { route: string }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<TocItem[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useLayoutEffect(() => {
    const raf = requestAnimationFrame(() => {
      const article = document.querySelector(".dx-article");
      if (!article) return;
      const hs = Array.from(article.querySelectorAll<HTMLElement>("h2[id], h3[id]"));
      setItems(
        hs.map((h) => ({
          id: h.id,
          text: h.textContent || "",
          level: h.tagName === "H3" ? 3 : 2,
        })),
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [route]);

  useEffect(() => {
    if (items.length === 0) return;
    function onScroll() {
      const offset = 96;
      let cur = items[0].id;
      for (const it of items) {
        const el = document.getElementById(it.id);
        if (el && el.getBoundingClientRect().top - offset <= 0) cur = it.id;
      }
      setActive(cur);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [items]);

  if (items.length < 2) return <div className="dx-toc" aria-hidden="true" />;

  return (
    <nav className="dx-toc">
      <div className="dx-toc-label">{t("docs.toc.label", "On this page")}</div>
      <ul className="dx-toc-list">
        {items.map((it) => (
          <li key={it.id}>
            <a
              className={"dx-toc-link lvl-" + it.level + (active === it.id ? " is-active" : "")}
              href={"#" + it.id}
              onClick={(e) => {
                e.preventDefault();
                const el = document.getElementById(it.id);
                if (el) {
                  const y = el.getBoundingClientRect().top + window.scrollY - 76;
                  window.scrollTo({ top: y, behavior: "smooth" });
                }
              }}
            >
              {it.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
