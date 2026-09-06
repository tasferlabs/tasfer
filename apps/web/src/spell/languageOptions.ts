import { SPELL_PREF_KEYS } from "./personalDictionary";

/**
 * A setting that belongs to one dictionary rather than to spelling as a whole.
 *
 * Two places show these and they must agree: the install step, so a choice is
 * made while the language is being added, and the language's row menu in
 * Settings, so it can be changed later. Keeping the list here means adding a
 * language-specific option is one entry, not two screens to remember.
 *
 * Options are keyed off the dictionary id, never its script. The lenient
 * Arabic setting folds hamza, ta marbuta and alif maqsura — an Arabic rule,
 * not an Arabic-script one — and Persian and Urdu must not inherit it.
 */
export interface LanguageOption {
  /** Own-prefs key holding the boolean (see {@link SPELL_PREF_KEYS}). */
  pref: string;
  /** i18n key and English source text for the label and its one-line hint. */
  labelKey: string;
  label: string;
  hintKey: string;
  hint: string;
}

const LENIENT_ARABIC: LanguageOption = {
  pref: SPELL_PREF_KEYS.lenientArabic,
  labelKey: "settings.spelling.lenientArabic",
  label: "Accept spelling variants",
  hintKey: "settings.spelling.lenientArabicHint",
  hint: "Accept common hamza, ة/ه and ى/ي variants.",
};

/** The options for one dictionary, in display order; empty for most. */
export function languageOptions(id: string): readonly LanguageOption[] {
  return id === "ar" ? [LENIENT_ARABIC] : [];
}
