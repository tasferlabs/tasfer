import { Check, Search, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  dictionaryEndonym,
  formatDictionarySize,
  makeDictionaryNamer,
  type DictionaryDescriptor,
} from "@/spell/dictionaries";
import type { SpellService } from "@/spell/SpellService";
import styles from "./AddLanguageDialog.module.css";

/**
 * Pick a language to check spelling in.
 *
 * A search field over every dictionary Tasfer can fetch, rather than a
 * checklist on the settings page: the catalog is far too long to sit inline,
 * and nobody wants to scroll past forty languages to reach the option below
 * them. Matching is on the name in the interface language, the name in the
 * language's own words, and the tag itself, so "de", "German" and "Deutsch"
 * all find the same row.
 */
export function AddLanguageDialog({
  service,
  catalog,
  open,
  onOpenChange,
  onAddFile,
}: {
  service: SpellService;
  catalog: readonly DictionaryDescriptor[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Escape hatch to the file importer, for a language Tasfer does not carry. */
  onAddFile: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");

  const added = new Set(service.languages());
  const nameOf = useMemo(
    () => makeDictionaryNamer(i18n.language),
    [i18n.language],
  );

  const rows = useMemo(() => {
    const collator = new Intl.Collator(i18n.language);
    return catalog
      .map((d) => ({
        d,
        name: nameOf(d),
        endonym: dictionaryEndonym(d, i18n.language),
      }))
      .sort((a, b) => collator.compare(a.name, b.name));
  }, [catalog, nameOf, i18n.language]);

  const needle = query.trim().toLocaleLowerCase(i18n.language);
  const matches = needle
    ? rows.filter(
        (r) =>
          r.name.toLocaleLowerCase(i18n.language).includes(needle) ||
          r.endonym?.toLocaleLowerCase(i18n.language).includes(needle) ||
          r.d.id.toLowerCase().includes(needle),
      )
    : rows;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("settings.spelling.addLanguage.title", "Add a language")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "settings.spelling.addLanguage.description",
              "Its dictionary downloads the first time you write in it, then stays on this device.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className={styles.searchWrap}>
          <Search className={styles.searchIcon} aria-hidden />
          <Input
            type="search"
            className={styles.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(
              "settings.spelling.addLanguage.search",
              "Search languages",
            )}
            aria-label={t(
              "settings.spelling.addLanguage.search",
              "Search languages",
            )}
          />
        </div>

        {matches.length === 0 ? (
          <p className={styles.empty}>
            {t(
              "settings.spelling.addLanguage.noMatches",
              "No language matches “{{query}}”. If you have its Hunspell files, add them from disk.",
              { query: query.trim() },
            )}
          </p>
        ) : (
          <ul className={styles.list}>
            {matches.map(({ d, name, endonym }) => {
              const on = added.has(d.id);
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    className={styles.row}
                    aria-pressed={on}
                    onClick={() => {
                      if (on) void service.disableLanguage(d.id);
                      else void service.enableLanguage(d.id);
                    }}
                  >
                    <span className={styles.rowText}>
                      <span className={styles.name}>{name}</span>
                      {endonym && (
                        <span className={styles.endonym} dir="auto">
                          {endonym}
                        </span>
                      )}
                    </span>
                    <span className={styles.size}>
                      {formatDictionarySize(d.wireSizeBytes, i18n.language)}
                    </span>
                    {on ? (
                      <Check className={styles.check} aria-hidden />
                    ) : (
                      <span className={styles.check} aria-hidden />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter className={styles.footer}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenChange(false);
              onAddFile();
            }}
          >
            <Upload className="size-4" aria-hidden />
            {t(
              "settings.spelling.addLanguage.fromFile",
              "Add from a file instead",
            )}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.done", "Done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
