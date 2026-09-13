import { ArrowLeft, Search, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import useMobileLayout from "@/app/hooks/useMobileLayout";
import { cn } from "@/lib/utils";
import {
  dictionaryEndonym,
  formatDictionarySize,
  makeDictionaryNamer,
  type DictionaryDescriptor,
} from "@/spell/dictionaries";
import { languageOptions, type LanguageOption } from "@/spell/languageOptions";
import type { SpellService } from "@/spell/SpellService";
import { useSpellSetting } from "@/spell/SpellProvider";
import styles from "./AddLanguageDialog.module.css";

/** A language's name, its own name for itself, and how big its dictionary is. */
interface Row {
  d: DictionaryDescriptor;
  name: string;
  endonym: string | null;
}

/**
 * Pick the languages to check spelling in.
 *
 * Two steps, because ticking a box in a list of ninety is a cheap gesture with
 * an expensive result — each language is a download and one more engine
 * answering every word. Choosing is reversible browsing; installing is the
 * commitment, and it names what will be downloaded, how much it comes to, and
 * whatever the chosen languages let you decide up front (Arabic's variant
 * tolerance, say) before any of it happens.
 *
 * A search field over the catalogue rather than a checklist on the settings
 * page: the list is far too long to sit inline, and nobody wants to scroll
 * past ninety languages to reach the option below them. Matching is on the
 * name in the interface language, the name in the language's own words, and
 * the tag itself, so "de", "German" and "Deutsch" all find the same row.
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
  const { isMobile } = useMobileLayout();
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);
  /** The languages that will be checked once this dialog is confirmed. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const installed = service.languages();

  // Opening starts from what is actually checked today, so a dialog closed
  // halfway through never leaves a stale selection behind the next time.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setConfirming(false);
    setPicked(new Set(service.languages()));
  }, [open, service]);

  const nameOf = useMemo(
    () => makeDictionaryNamer(i18n.language),
    [i18n.language],
  );

  const rows = useMemo<Row[]>(() => {
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

  const adding = rows.filter(
    (r) => picked.has(r.d.id) && !installed.includes(r.d.id),
  );
  const removing = rows.filter(
    (r) => !picked.has(r.d.id) && installed.includes(r.d.id),
  );
  const totalBytes = adding.reduce((n, r) => n + r.d.wireSizeBytes, 0);

  const toggle = (id: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const apply = () => {
    // Removals first: dropping a language before adding others keeps
    // `spell.languages` in the order the person sees, and an unticked
    // language stops being checked even if an addition fails to download.
    // The row's status carries a failed download, so nothing is surfaced
    // here; the catch only keeps a rejection from going unhandled.
    const settle = (p: Promise<void>) => void p.catch(() => {});
    for (const r of removing) settle(service.disableLanguage(r.d.id));
    for (const r of adding) settle(service.enableLanguage(r.d.id));
    onOpenChange(false);
  };

  // The picker and the install step are one screen changing its mind, so both
  // are described the same way and the surface — dialog or drawer — is chosen
  // once, at the bottom.
  const title = confirming
    ? t("settings.spelling.addLanguage.confirmTitle", {
        count: adding.length,
        defaultValue_one: "Install 1 language",
        defaultValue_other: "Install {{count}} languages",
      })
    : t("settings.spelling.addLanguage.title", "Add languages");

  const description = confirming
    ? t(
        "settings.spelling.addLanguage.confirmDescription",
        "{{size}} in total. Each dictionary downloads the first time you write in that language, then stays on this device.",
        { size: formatDictionarySize(totalBytes, i18n.language) },
      )
    : t(
        "settings.spelling.addLanguage.description",
        "Tick the languages you write in, then install them. A dictionary downloads the first time you write in its language and stays on this device.",
      );

  const confirmBody = (
    <>
      <ul className={cn(styles.summary, isMobile && styles.fill)}>
        {adding.map(({ d, name, endonym }) => (
          <li key={d.id} className={styles.summaryItem}>
            <span className={styles.rowText}>
              <span className={styles.name} dir="auto">
                {name}
              </span>
              {endonym && (
                <span className={styles.endonym} dir="auto">
                  {endonym}
                </span>
              )}
            </span>
            <span className={styles.size}>
              {formatDictionarySize(d.wireSizeBytes, i18n.language)}
            </span>
            {languageOptions(d.id).map((option) => (
              <OptionToggle key={option.pref} option={option} />
            ))}
          </li>
        ))}
      </ul>

      {removing.length > 0 && (
        <p className={styles.removing}>
          {t(
            "settings.spelling.addLanguage.alsoRemoving",
            "Tasfer will stop checking {{languages}}. Their dictionaries stay on this device.",
            {
              languages: new Intl.ListFormat(i18n.language, {
                type: "conjunction",
              }).format(removing.map((r) => r.name)),
            },
          )}
        </p>
      )}
    </>
  );

  const pickBody = (
    <>
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
        <p className={cn(styles.empty, isMobile && styles.fill)}>
          {t(
            "settings.spelling.addLanguage.noMatches",
            "No language matches “{{query}}”. If you have its Hunspell files, add them from disk.",
            { query: query.trim() },
          )}
        </p>
      ) : (
        <ul className={cn(styles.list, isMobile && styles.fill)}>
          {matches.map(({ d, name, endonym }) => (
            <li key={d.id}>
              <label className={styles.row}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={picked.has(d.id)}
                  onChange={() => toggle(d.id)}
                />
                <span className={styles.rowText}>
                  <span className={styles.name} dir="auto">
                    {name}
                  </span>
                  {endonym && (
                    <span className={styles.endonym} dir="auto">
                      {endonym}
                    </span>
                  )}
                </span>
                <span className={styles.size}>
                  {installed.includes(d.id)
                    ? t("settings.spelling.addLanguage.added", "Added")
                    : formatDictionarySize(d.wireSizeBytes, i18n.language)}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const backButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => setConfirming(false)}
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t("common.back", "Back")}
    </Button>
  );
  const installButton = (
    <Button type="button" onClick={apply}>
      {t("settings.spelling.addLanguage.install", "Install")}
    </Button>
  );
  const fromFileButton = (
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
      {t("settings.spelling.addLanguage.fromFile", "Add from a file instead")}
    </Button>
  );
  const commitButton =
    adding.length > 0 ? (
      <Button type="button" onClick={() => setConfirming(true)}>
        {t("settings.spelling.addLanguage.installCount", {
          count: adding.length,
          size: formatDictionarySize(totalBytes, i18n.language),
          defaultValue_one: "Install 1 language · {{size}}",
          defaultValue_other: "Install {{count}} languages · {{size}}",
        })}
      </Button>
    ) : (
      <Button
        type="button"
        onClick={removing.length > 0 ? apply : () => onOpenChange(false)}
      >
        {removing.length > 0
          ? t("common.save", "Save")
          : t("common.done", "Done")}
      </Button>
    );

  const body = confirming ? confirmBody : pickBody;
  // Stacked in the drawer, the button that carries the step comes first.
  const mobileFooter = confirming ? (
    <>
      {installButton}
      {backButton}
    </>
  ) : (
    <>
      {commitButton}
      {fromFileButton}
    </>
  );
  const desktopFooter = confirming ? (
    <>
      {backButton}
      {installButton}
    </>
  ) : (
    <>
      {fromFileButton}
      {commitButton}
    </>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="flex min-h-0 flex-1 flex-col">
            <DrawerHeader>
              <DrawerTitle>{title}</DrawerTitle>
              <DrawerDescription>{description}</DrawerDescription>
            </DrawerHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-4 px-4">
              {body}
            </div>
            <DrawerFooter>{mobileFooter}</DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {body}

        <DialogFooter className={styles.footer}>{desktopFooter}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One language-specific setting, shown while its language is being installed.
 *
 * It writes straight to own-prefs rather than waiting for the install to be
 * confirmed: the setting is per language and survives the language being
 * removed and added again, so there is nothing to roll back if the person
 * goes back a step.
 */
function OptionToggle({ option }: { option: LanguageOption }) {
  const { t } = useTranslation();
  const setting = useSpellSetting<boolean>(option.pref, false);
  return (
    <label className={styles.option}>
      <input
        type="checkbox"
        className={styles.checkbox}
        checked={setting.value}
        onChange={(e) => setting.set(e.target.checked)}
      />
      <span className={styles.optionText}>
        <span>{t(option.labelKey, option.label)}</span>
        <span className={styles.optionHint}>
          {t(option.hintKey, option.hint)}
        </span>
      </span>
    </label>
  );
}
