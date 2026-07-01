import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useTheme, type Theme } from "@/app/hooks/useTheme";
import { useConfirmation } from "@/app/components/ConfirmationDialog";
import {
  usePageSettings,
  DENSITY_STOPS,
  DEFAULT_DENSITY,
} from "@/app/contexts/PageSettingsContext";
import styles from "./AppearanceSettings.module.css";

// ── shared section shell ────────────────────────────────────────────────────
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
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

// ── Display density ─────────────────────────────────────────────────────────
const formatScale = (value: number) => `${value.toFixed(1)}×`;

const nearestStopIndex = (value: number) => {
  let best = 0;
  for (let i = 1; i < DENSITY_STOPS.length; i++) {
    if (
      Math.abs(DENSITY_STOPS[i] - value) < Math.abs(DENSITY_STOPS[best] - value)
    ) {
      best = i;
    }
  }
  return best;
};

// Relative bar widths (% of card). Bar height and gap grow from dense →
// spacious, so the three cards read as tighter/looser at a glance.
const DENSITY_CARDS = [
  {
    zone: "dense" as const,
    targetIndex: 0,
    colClass: "colDense",
    barHeight: 4,
    gap: 4,
    bars: [56, 100, 94, 98, 88, 96, 62],
  },
  {
    zone: "default" as const,
    targetIndex: 3,
    colClass: "colDefault",
    barHeight: 5,
    gap: 8,
    bars: [52, 100, 92, 60],
  },
  {
    zone: "spacious" as const,
    targetIndex: 6,
    colClass: "colSpacious",
    barHeight: 6,
    gap: 13,
    bars: [48, 100, 58],
  },
];

export function DisplayDensity() {
  const { t } = useTranslation();
  const { density, setDensity } = usePageSettings();

  const activeIndex = nearestStopIndex(density);
  const zone = density < 1 ? "dense" : density > 1 ? "spacious" : "default";

  const cardLabel: Record<string, string> = {
    dense: t("settings.density.dense", "Dense"),
    default: t("common.default", "Default"),
    spacious: t("settings.density.spacious", "Spacious"),
  };

  return (
    <Section
      title={t("settings.density.title", "Display density")}
      description={t(
        "settings.density.description",
        "How tightly your words sit on the page. Rendered on your machine, tuned to your eyes.",
      )}
    >
      <div className={styles.previews}>
        {DENSITY_CARDS.map((card) => {
          const active = zone === card.zone;
          return (
            <button
              type="button"
              key={card.zone}
              className={cn(styles.card, styles[card.colClass])}
              aria-pressed={active}
              onClick={() => setDensity(DENSITY_STOPS[card.targetIndex])}
            >
              <div
                className={cn(
                  styles.cardBox,
                  active
                    ? "border-primary text-primary"
                    : "border-border text-muted-foreground",
                )}
                style={{ gap: card.gap }}
              >
                {card.bars.map((width, i) => (
                  <div
                    key={i}
                    className={styles.bar}
                    style={{ height: card.barHeight, width: `${width}%` }}
                  />
                ))}
              </div>
              <span
                className={cn(
                  styles.cardLabel,
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {cardLabel[card.zone]}
              </span>
            </button>
          );
        })}
      </div>

      <div className={styles.track}>
        <div className={styles.trackLine} />
        <div className={styles.stops}>
          {DENSITY_STOPS.map((stop, i) => {
            const isActive = i === activeIndex;
            return (
              <button
                type="button"
                key={stop}
                className={styles.stop}
                onClick={() => setDensity(stop)}
                aria-pressed={isActive}
                aria-label={formatScale(stop)}
              >
                <span className={styles.stopDotWrap}>
                  <span
                    className={cn(
                      styles.stopDot,
                      isActive
                        ? "border-primary border-[4px]"
                        : "border-muted-foreground border-[1.5px]",
                    )}
                  />
                </span>
                <span
                  className={cn(
                    styles.stopLabel,
                    isActive ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {formatScale(stop)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.reset}
          onClick={() => setDensity(DEFAULT_DENSITY)}
        >
          {t("settings.density.reset", "Reset")}
        </button>
      </div>
    </Section>
  );
}

// ── Language ────────────────────────────────────────────────────────────────
// Only the languages the app actually ships translations for. Language endonyms
// are shown in their own script, so they are not run through i18next.
const LANGUAGES: Array<{
  id: string;
  code: string;
  native: string;
  dir: "ltr" | "rtl";
}> = [
  { id: "en", code: "EN", native: "English", dir: "ltr" },
  { id: "ar", code: "AR", native: "العربية", dir: "rtl" },
];

export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  const { getConfirmation } = useConfirmation();
  const current = i18n.resolvedLanguage ?? i18n.language;

  async function selectLanguage(id: string) {
    if (id === current) return;
    const confirmed = await getConfirmation({
      title: t("common.areYouSure", "Are you sure?"),
      description: t(
        "settings.language.changingReload",
        "Changing the language will reload the page.",
      ),
    });
    if (!confirmed) return;

    document.cookie = `locale=${id};path=/;max-age=${365 * 24 * 60 * 60}`;
    i18n.changeLanguage(id);
    window.location.reload();
  }

  return (
    <Section
      title={t("settings.language.title", "Language")}
      description={t(
        "settings.language.description",
        "The interface, in your tongue. Switches instantly — the editor reflows metrics and re-renders on the spot.",
      )}
    >
      <div className={styles.langGrid}>
        {LANGUAGES.map((lang) => {
          const active = current === lang.id;
          return (
            <button
              type="button"
              key={lang.id}
              dir={lang.dir}
              aria-pressed={active}
              className={cn(styles.langPill, active && styles.langPillActive)}
              onClick={() => selectLanguage(lang.id)}
            >
              <span className={styles.langNative}>{lang.native}</span>
              <span
                className={cn(styles.langCode, active && styles.langCodeActive)}
              >
                {lang.code}
              </span>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ── Theme ───────────────────────────────────────────────────────────────────
// Illustrative "paper" swatches. These depict light/dark regardless of the
// active theme, so the colors are fixed literals, not theme tokens.
interface ThemePane {
  width: string;
  background: string;
  head: string;
  line: string;
  headWidth: number;
  lines: number[];
}

const LIGHT_PANE = (width: string): ThemePane => ({
  width,
  background: "#ffffff",
  head: "#18181b",
  line: "#d4d4d8",
  headWidth: 60,
  lines: [100, 90, 96],
});

const DARK_PANE = (width: string, lines = [100, 84]): ThemePane => ({
  width,
  background: "#18181b",
  head: "#e4e4e7",
  line: "#3f3f46",
  headWidth: 70,
  lines,
});

const THEME_DEFS: Array<{ id: Theme; panes: ThemePane[] }> = [
  { id: "light", panes: [LIGHT_PANE("100%")] },
  { id: "dark", panes: [DARK_PANE("100%", [100, 90, 96])] },
  { id: "system", panes: [LIGHT_PANE("50%"), DARK_PANE("50%")] },
];

export function ThemeSelect() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  const label: Record<Theme, string> = {
    light: t("settings.theme.light", "Light"),
    dark: t("settings.theme.dark", "Dark"),
    system: t("settings.theme.system", "System"),
  };

  return (
    <Section
      title={t("settings.theme.title", "Theme")}
      description={t(
        "settings.theme.description",
        "Light, dark, or whatever your system says. The canvas is themed on its own layer — never a washed-out invert.",
      )}
    >
      <div className={styles.themeGrid}>
        {THEME_DEFS.map((def) => {
          const active = theme === def.id;
          return (
            <button
              type="button"
              key={def.id}
              className={styles.card}
              aria-pressed={active}
              onClick={() => setTheme(def.id)}
            >
              <div
                className={cn(
                  styles.themeFrame,
                  active && styles.themeFrameActive,
                )}
              >
                <div className={styles.themePaper}>
                  {def.panes.map((pane, i) => (
                    <div
                      key={i}
                      className={styles.themePane}
                      style={{ width: pane.width, background: pane.background }}
                    >
                      <div
                        className={styles.themeBar}
                        style={{
                          height: 5,
                          width: `${pane.headWidth}%`,
                          background: pane.head,
                        }}
                      />
                      {pane.lines.map((width, j) => (
                        <div
                          key={j}
                          className={styles.themeBar}
                          style={{
                            height: 4,
                            width: `${width}%`,
                            background: pane.line,
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <span
                className={cn(
                  styles.cardLabel,
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {label[def.id]}
              </span>
            </button>
          );
        })}
      </div>
    </Section>
  );
}
