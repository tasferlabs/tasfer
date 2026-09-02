import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { isApplePlatform } from "@tasfer/editor";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { BUNDLED_DICTIONARIES } from "@/spell/dictionaries";
import { SPELL_PREF_KEYS } from "@/spell/personalDictionary";
import type { SpellService } from "@/spell/SpellService";
import { useSpellService, useSpellSetting } from "@/spell/SpellProvider";
import { spellShortcutKeys } from "@/spell/spellShortcut";
import { Section } from "./AppearanceSettings";
import { PersonalDictionaryDialog } from "./PersonalDictionaryDialog";
import styles from "./Preferences.module.css";

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

function formatMegabytes(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(bytes / 1_000_000);
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

  // Spelling needs the synced-prefs store; without it there is nothing to set.
  if (!service) return null;

  const shortcut = spellShortcutKeys(isApplePlatform()).join("");
  const enabledLanguages = new Set(service.languages());
  const wordCount = service.words().length;

  const statusLabel = (status: ReturnType<SpellService["status"]>) => {
    switch (status) {
      case "ready":
        return t("settings.spelling.status.ready", "Downloaded");
      case "downloading":
        return t("settings.spelling.status.downloading", "Downloading…");
      case "error":
        return t("settings.spelling.status.error", "Couldn't download");
      default:
        return t(
          "settings.spelling.status.missing",
          "Downloads when first needed",
        );
    }
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

      <div className={styles.row}>
        <div className={styles.column}>
          <p className={cn("text-sm", styles.title)}>
            {t("settings.spelling.languages", "Languages")}
          </p>
          <p className="text-sm opacity-75">
            {t(
              "settings.spelling.languagesHint",
              "Dictionaries download the first time they are needed and stay on this device.",
            )}
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {BUNDLED_DICTIONARIES.map((dict) => {
              const on = enabledLanguages.has(dict.id);
              const status = service.status(dict.id);
              return (
                <li
                  key={dict.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1"
                >
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={on}
                      disabled={!enabled.value}
                      onChange={(e) => {
                        if (e.target.checked) {
                          service.enableLanguage(dict.id);
                          void service.ensureLoaded(dict.id);
                        } else {
                          service.disableLanguage(dict.id);
                        }
                      }}
                    />
                    <span>{t(dict.labelKey, dict.id)}</span>
                    <span className="text-muted-foreground">
                      {t("settings.spelling.sizeMb", "{{size}} MB", {
                        size: formatMegabytes(dict.wireSizeBytes, i18n.language),
                      })}
                    </span>
                  </label>
                  <span className="text-xs text-muted-foreground" role="status">
                    {statusLabel(status)}
                  </span>
                  {status === "error" && (
                    <button
                      type="button"
                      className="text-xs underline text-muted-foreground hover:text-foreground"
                      onClick={() => void service.ensureLoaded(dict.id)}
                    >
                      {t("settings.spelling.retry", "Retry")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <SwitchRow
        title={t("settings.spelling.lenientArabic", "Lenient Arabic spelling")}
        hint={t(
          "settings.spelling.lenientArabicHint",
          "Accept common hamza, ة/ه and ى/ي variants.",
        )}
        checked={lenientArabic.value}
        disabled={!enabled.value}
        onCheckedChange={lenientArabic.set}
      />
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

      <div className={styles.row}>
        <div className={styles.column}>
          <p className={cn("text-sm", styles.title)}>
            {t("settings.spelling.personalDictionary", "Personal dictionary")}
          </p>
          <p className="text-sm opacity-75">
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
          className="self-start"
          onClick={() => setDictionaryOpen(true)}
        >
          {t("settings.spelling.manage", "Manage")}
        </Button>
      </div>

      <PersonalDictionaryDialog
        service={service}
        open={dictionaryOpen}
        onOpenChange={setDictionaryOpen}
      />
    </Section>
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
    <div className={styles.row}>
      <div className={styles.column}>
        <label htmlFor={id} className={cn("text-sm", styles.title)}>
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
