import { MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { isApplePlatform } from "@tasfer/editor";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  dictionaryEndonym,
  formatDictionarySize,
  makeDictionaryNamer,
  type DictionaryDescriptor,
} from "@/spell/dictionaries";
import { SPELL_PREF_KEYS } from "@/spell/personalDictionary";
import type { ImportBytes } from "@/spell/userDictionaries";
import type { SpellService } from "@/spell/SpellService";
import { useSpellService, useSpellSetting } from "@/spell/SpellProvider";
import { spellShortcutKeys } from "@/spell/spellShortcut";
import { AddDictionaryDialog } from "./AddDictionaryDialog";
import { AddLanguageDialog } from "./AddLanguageDialog";
import { PersonalDictionaryDialog } from "./PersonalDictionaryDialog";
import { Section } from "./AppearanceSettings";
import styles from "./SpellingSettings.module.css";
import prefStyles from "./Preferences.module.css";

/**
 * Re-render whenever the service reports a change (dictionary status, the
 * personal dictionary, flag counts). A tick, not a snapshot: the service's
 * getters are read fresh on each render.
 */
export function useSpellServiceTick(service: SpellService | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!service) return;
    return service.subscribe(() => setTick((n) => n + 1));
  }, [service]);
  return tick;
}

export function SpellingSettings() {
  const { t, i18n } = useTranslation();
  const service = useSpellService();
  useSpellServiceTick(service);
  const enabled = useSpellSetting<boolean>(SPELL_PREF_KEYS.enabled, true);
  const lenientArabic = useSpellSetting<boolean>(
    SPELL_PREF_KEYS.lenientArabic,
    false,
  );
  const flagAllCaps = useSpellSetting<boolean>(
    SPELL_PREF_KEYS.flagAllCaps,
    false,
  );
  const highContrast = useSpellSetting<boolean>(
    SPELL_PREF_KEYS.highContrast,
    false,
  );
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [addLanguageOpen, setAddLanguageOpen] = useState(false);
  const [addFileOpen, setAddFileOpen] = useState(false);
  /** A word list the personal dictionary handed over for being over the cap. */
  const [handover, setHandover] = useState<ImportBytes | undefined>();

  const nameOf = useMemo(
    () => makeDictionaryNamer(i18n.language),
    [i18n.language],
  );

  // Spelling needs the synced-prefs store; without it there is nothing to set.
  if (!service) return null;

  const shortcut = spellShortcutKeys(isApplePlatform()).join("");
  const catalog = service.bundledDictionaries();
  const byId = new Map(service.availableDictionaries().map((d) => [d.id, d]));
  // The order the person put them in, not the order the catalog happens to be
  // in: the first dictionary that accepts a word is the one that answers.
  const addedIds = service.languages();
  const added = addedIds
    .map((id) => byId.get(id))
    .filter((d): d is DictionaryDescriptor => Boolean(d));
  // Imported dictionaries are always on; they have no catalog entry to add from.
  const importedOnly = service
    .importedDictionaries()
    .filter((d) => !addedIds.includes(d.id));
  const rows = [...added, ...importedOnly];
  const wordCount = service.words().length;

  const openFileImport = (list?: ImportBytes) => {
    setHandover(list);
    setAddFileOpen(true);
  };

  return (
    <Section
      title={t("settings.spelling.title", "Spelling")}
      description={t(
        "settings.spelling.description",
        "Misspelled words get a red underline as you type. Use the right-click menu or {{shortcut}} to fix one.",
        { shortcut },
      )}
    >
      <SwitchRow
        title={t("settings.spelling.enabled", "Check spelling as you type")}
        hint={t(
          "settings.spelling.enabledHint",
          "Underline misspelled words while you write.",
        )}
        checked={enabled.value}
        onCheckedChange={enabled.set}
      />

      <div className={styles.groupHeader}>
        <div>
          <h4 className={styles.groupTitle}>
            {t("settings.spelling.languages", "Languages")}
          </h4>
          <p className={styles.groupHint}>
            {t(
              "settings.spelling.languagesHint",
              "Every language you add is checked. Dictionaries download when first needed and stay on this device.",
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={!enabled.value}
          onClick={() => setAddLanguageOpen(true)}
        >
          <Plus className="size-4" aria-hidden />
          {t("settings.spelling.addLanguage.open", "Add language")}
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className={styles.list}>
          <p className={styles.empty}>
            {t(
              "settings.spelling.noLanguages",
              "No languages yet. Add one and Tasfer starts checking what you write in it.",
            )}
          </p>
        </div>
      ) : (
        <ul className={styles.list}>
          {rows.map((d) => (
            <LanguageRow
              key={d.id}
              dictionary={d}
              service={service}
              name={nameOf(d)}
              endonym={dictionaryEndonym(d, i18n.language)}
              disabled={!enabled.value}
              lenientArabic={lenientArabic}
            />
          ))}
        </ul>
      )}

      <div className={styles.groupHeader}>
        <div>
          <h4 className={styles.groupTitle}>
            {t("settings.spelling.marking", "How misspellings are marked")}
          </h4>
        </div>
      </div>
      <SwitchRow
        title={t("settings.spelling.flagAllCaps", "Flag words in ALL CAPS")}
        hint={t(
          "settings.spelling.flagAllCapsHint",
          "Off by default: acronyms and codes are rarely typos.",
        )}
        checked={flagAllCaps.value}
        disabled={!enabled.value}
        onCheckedChange={flagAllCaps.set}
      />
      <SwitchRow
        title={t("settings.spelling.highContrast", "High-contrast underline")}
        hint={t(
          "settings.spelling.highContrastHint",
          "A thicker underline that is easier to spot.",
        )}
        checked={highContrast.value}
        disabled={!enabled.value}
        onCheckedChange={highContrast.set}
      />

      <div className={styles.groupHeader}>
        <div>
          <h4 className={styles.groupTitle}>
            {t("settings.spelling.personalDictionary", "Personal dictionary")}
          </h4>
          <p className={styles.groupHint}>
            {t("settings.spelling.personalDictionaryCount", {
              count: wordCount,
              defaultValue_one: "{{count}} word · Synced to your devices",
              defaultValue_other: "{{count}} words · Synced to your devices",
            })}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setDictionaryOpen(true)}
        >
          {t("settings.spelling.manage", "Manage")}
        </Button>
      </div>

      <AddLanguageDialog
        service={service}
        catalog={catalog}
        open={addLanguageOpen}
        onOpenChange={setAddLanguageOpen}
        onAddFile={() => openFileImport()}
      />

      <PersonalDictionaryDialog
        service={service}
        open={dictionaryOpen}
        onOpenChange={setDictionaryOpen}
        onTooManyWords={(list) => {
          setDictionaryOpen(false);
          openFileImport(list);
        }}
      />

      <AddDictionaryDialog
        service={service}
        open={addFileOpen}
        onOpenChange={setAddFileOpen}
        initialList={handover}
      />
    </Section>
  );
}

/**
 * One added language. Everything specific to it — its download, and any option
 * only it has — lives in this row's menu, so a person who writes in German
 * never reads a switch about Arabic hamza forms.
 *
 * Language-specific options key off the dictionary id, never its script: the
 * lenient setting folds hamza, ta marbuta and alif maqsura, which is an Arabic
 * rule, not an Arabic-script one. Persian and Urdu share the script and must
 * not inherit it.
 */
function LanguageRow({
  dictionary,
  service,
  name,
  endonym,
  disabled,
  lenientArabic,
}: {
  dictionary: DictionaryDescriptor;
  service: SpellService;
  name: string;
  endonym: string | null;
  disabled: boolean;
  lenientArabic: { value: boolean; set: (next: boolean) => void };
}) {
  const { t, i18n } = useTranslation();
  const imported = dictionary.source.kind === "imported";
  const status = service.status(dictionary.id);
  const size = formatDictionarySize(
    imported ? dictionary.sizeBytes : dictionary.wireSizeBytes,
    i18n.language,
  );

  const statusText = imported
    ? t("settings.spelling.status.imported", "Added on this device")
    : status === "ready"
      ? t("settings.spelling.status.ready", "On this device")
      : status === "downloading"
        ? t("settings.spelling.status.downloading", "Downloading…")
        : status === "error"
          ? t("settings.spelling.status.error", "Couldn’t download")
          : t(
              "settings.spelling.status.missing",
              "Downloads when first needed",
            );

  return (
    <li className={styles.item}>
      <div className={styles.itemText}>
        <span className={styles.name} dir="auto">
          {name}
        </span>
        {endonym && (
          <span className={styles.endonym} dir="auto">
            {endonym}
          </span>
        )}
        <p
          className={cn(
            styles.meta,
            status === "downloading" && styles.working,
            status === "error" && !imported && styles.failed,
          )}
          role={status === "downloading" ? "status" : undefined}
        >
          {size} · {statusText}
          {status === "error" && !imported && (
            <button
              type="button"
              className={styles.retry}
              onClick={() => void service.ensureLoaded(dictionary.id)}
            >
              {t("settings.spelling.retry", "Retry")}
            </button>
          )}
        </p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={styles.menuButton}
            disabled={disabled}
            aria-label={t("settings.spelling.rowMenu", "Options for {{name}}", {
              name,
            })}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={styles.menu}>
          {dictionary.id === "ar" && (
            <>
              <DropdownMenuCheckboxItem
                checked={lenientArabic.value}
                onCheckedChange={lenientArabic.set}
                className={styles.optionItem}
              >
                <span>
                  {t(
                    "settings.spelling.lenientArabic",
                    "Accept spelling variants",
                  )}
                </span>
                <span className={styles.optionHint}>
                  {t(
                    "settings.spelling.lenientArabicHint",
                    "Accept common hamza, ة/ه and ى/ي variants.",
                  )}
                </span>
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
            </>
          )}
          {imported ? (
            <DropdownMenuItem
              onClick={() => void service.imported?.remove(dictionary.id)}
            >
              {t("settings.spelling.removeDictionary", "Remove")}
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem
                onClick={() => void service.disableLanguage(dictionary.id)}
              >
                {t(
                  "settings.spelling.removeLanguage",
                  "Stop checking this language",
                )}
              </DropdownMenuItem>
              {status === "ready" && (
                <DropdownMenuItem
                  onClick={() => void service.removeFromDevice(dictionary.id)}
                >
                  {t(
                    "settings.spelling.removeFromDevice",
                    "Remove from this device",
                  )}
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function SwitchRow({
  title,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  title: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div className={prefStyles.row}>
      <div className={prefStyles.column}>
        <label htmlFor={id} className={cn("text-sm", prefStyles.title)}>
          {title}
        </label>
        <p className="text-sm opacity-75">{hint}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="mt-1 shrink-0"
      />
    </div>
  );
}
