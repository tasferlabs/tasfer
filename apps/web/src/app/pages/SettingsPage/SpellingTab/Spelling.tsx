import { MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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
import { ShortcutKeys } from "@/app/components/ShortcutKeys";
import useResponsive from "@/app/hooks/useResponsive";
import { cn } from "@/lib/utils";
import {
  dictionaryEndonym,
  formatDictionarySize,
  makeDictionaryNamer,
  type DictionaryDescriptor,
} from "@/spell/dictionaries";
import { languageOptions, type LanguageOption } from "@/spell/languageOptions";
import { SPELL_PREF_KEYS } from "@/spell/personalDictionary";
import type { ImportBytes } from "@/spell/userDictionaries";
import type { SpellService } from "@/spell/SpellService";
import { useSpellService, useSpellSetting } from "@/spell/SpellProvider";
import { spellShortcutKeys } from "@/spell/spellShortcut";
import { AddDictionaryDialog } from "./AddDictionaryDialog";
import { AddLanguageDialog } from "./AddLanguageDialog";
import { PersonalDictionaryDialog } from "./PersonalDictionaryDialog";
import { Section } from "../shared/Section";
import rowStyles from "../shared/rows.module.css";
import styles from "./Spelling.module.css";

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

export function Spelling() {
  const { t, i18n } = useTranslation();
  const service = useSpellService();
  useSpellServiceTick(service);
  const enabled = useSpellSetting<boolean>(SPELL_PREF_KEYS.enabled, true);
  // Right-click and the chord are both mouse-and-keyboard affordances; a
  // touch-only device gets the suggestion bar above the keyboard instead.
  const isFine = useResponsive("(pointer: fine)");
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
    <div className={styles.container}>
      <Section
        title={t("settings.spelling.title", "Spelling")}
        description={
          isFine ? (
            <Trans
              i18nKey="settings.spelling.description"
              defaults="Misspelled words get a red underline as you type. Use the right-click menu or <shortcut /> to fix one."
              components={{
                shortcut: (
                  <ShortcutKeys keys={spellShortcutKeys(isApplePlatform())} />
                ),
              }}
            />
          ) : (
            t(
              "settings.spelling.descriptionTouch",
              "Misspelled words get a red underline as you type. Tap an underlined word to see suggestions in the toolbar above the keyboard.",
            )
          )
        }
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
                "Every language you add is checked, on all your devices. Each one downloads its dictionary when it first needs it.",
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
            {t("settings.spelling.addLanguage.open", "Add languages")}
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
              />
            ))}
          </ul>
        )}

        <div className={styles.groupHeader}>
          <div>
            <h4 className={styles.groupTitle}>
              {t("settings.spelling.personalDictionary", "Personal dictionary")}
            </h4>
            <p className={styles.groupHint}>
              {t("settings.spelling.personalDictionaryCount", {
                count: wordCount,
                defaultValue_one: "{{count}} word",
                defaultValue_other: "{{count}} words",
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
    </div>
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
}: {
  dictionary: DictionaryDescriptor;
  service: SpellService;
  name: string;
  endonym: string | null;
  disabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const imported = dictionary.source.kind === "imported";
  const status = service.status(dictionary.id);
  const options = languageOptions(dictionary.id);
  const size = formatDictionarySize(
    imported ? dictionary.sizeBytes : dictionary.wireSizeBytes,
    i18n.language,
  );

  // An imported dictionary follows the person, so "have we got it" is a
  // different question from "did a download work": its files come from another
  // of their devices, which has to be reachable rather than merely online at
  // some point. `presence` answers the first; `status` answers the second.
  const presence = imported ? service.presence(dictionary.id) : "here";
  const awayFromDevice = imported && presence === "elsewhere";
  const failed = status === "error" && !awayFromDevice;

  const statusText = awayFromDevice
    ? status === "downloading"
      ? t("settings.spelling.status.fetching", "Getting it from your device…")
      : t("settings.spelling.status.elsewhere", "On your other devices")
    : imported
      ? t("settings.spelling.status.imported", "On this device")
      : status === "ready"
        ? t("settings.spelling.status.ready", "On this device")
        : status === "downloading"
          ? t("settings.spelling.status.downloading", "Downloading…")
          : status === "error"
            ? t("settings.spelling.status.error", "Couldn’t download")
            : // A dictionary nobody has fetched yet says nothing: it downloads
              // on first use, and the size already tells you what that costs.
              null;

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
            failed && styles.failed,
          )}
          role={status === "downloading" ? "status" : undefined}
        >
          {size}
          {statusText && <> · {statusText}</>}
          {(failed || (awayFromDevice && status !== "downloading")) && (
            <button
              type="button"
              className={styles.retry}
              onClick={() => void service.ensureLoaded(dictionary.id)}
            >
              {awayFromDevice
                ? t("settings.spelling.fetch", "Get it now")
                : t("settings.spelling.retry", "Retry")}
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
          {options.length > 0 && (
            <>
              {options.map((option) => (
                <OptionItem key={option.pref} option={option} />
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          {imported ? (
            <DropdownMenuItem
              onClick={() => void service.imported?.remove(dictionary.id)}
            >
              {t(
                "settings.spelling.removeDictionary",
                "Remove from all your devices",
              )}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() => void service.disableLanguage(dictionary.id)}
            >
              {t("settings.spelling.removeLanguage", "Remove")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * One language-specific setting in a language's row menu. The same list drives
 * the install step in `AddLanguageDialog`, so an option is offered when the
 * language is added and stays reachable afterwards.
 */
function OptionItem({ option }: { option: LanguageOption }) {
  const { t } = useTranslation();
  const setting = useSpellSetting<boolean>(option.pref, false);
  return (
    <DropdownMenuCheckboxItem
      checked={setting.value}
      onCheckedChange={setting.set}
      className={styles.optionItem}
    >
      <span>{t(option.labelKey, option.label)}</span>
      <span className={styles.optionHint}>
        {t(option.hintKey, option.hint)}
      </span>
    </DropdownMenuCheckboxItem>
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
    <div className={rowStyles.row}>
      <div>
        <label htmlFor={id} className={cn("text-sm", rowStyles.title)}>
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
