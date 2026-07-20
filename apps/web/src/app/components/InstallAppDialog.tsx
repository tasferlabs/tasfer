import { Trans, useTranslation } from "react-i18next";
import { Star, Terminal } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { detectDeviceType } from "@/platform";
import useResponsive from "../hooks/useResponsive";

/**
 * Where each "install" button points. Desktop builds ship from GitHub
 * releases; neither store listing is live yet — the Play URL already uses the
 * real application id (app.tasfer) and the App Store URL is a placeholder
 * to swap once the listing exists.
 */
const DOWNLOAD_LINKS = {
  desktop: "https://github.com/hamza512b/tasfer/releases/latest",
  appStore: "https://apps.apple.com/app/tasfer",
  googlePlay: "https://play.google.com/store/apps/details?id=app.tasfer",
};

/**
 * The one web-install path relevant to this client, so the dialog shows a
 * single set of instructions instead of every platform's:
 *  - "ios" / "android" — phones and tablets (Add to Home Screen steps)
 *  - "safari" / "chromium" — desktop browsers that can install the PWA
 *  - "none" — desktop browsers without PWA install (e.g. Firefox); the
 *    web-install section is hidden and the desktop app leads.
 */
type InstallTarget = "ios" | "android" | "safari" | "chromium" | "none";

function detectInstallTarget(): InstallTarget {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const deviceType = detectDeviceType();
  if (deviceType === "phone" || deviceType === "tablet") {
    // iPadOS reports a "Macintosh" UA; detectDeviceType already classified it
    // as a tablet by touch support, so any Apple UA here means iOS/iPadOS.
    return /iPad|iPhone|iPod|Macintosh/i.test(ua) ? "ios" : "android";
  }
  // Every Chromium-based desktop browser carries "Chrome/"; Safari does not.
  if (/Chrome\//.test(ua)) return "chromium";
  if (/Safari\//.test(ua)) return "safari";
  return "none";
}

/* The instruction glyphs below reproduce the icons users actually see in
 * their browser chrome, so the mock UI is recognizable at a glance. The
 * Chrome/Android ones are the official Material Design icons (Apache-2.0);
 * the Apple-style ones are drawn to match the familiar system glyphs. */

/** Material `install_desktop` — the icon Chrome/Edge show in the address bar. */
function InstallDesktopIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M20 17H4V5h8V3H4c-1.11 0-2 .89-2 2v12a2 2 0 0 0 2 2h4v2h8v-2h4c1.1 0 2-.9 2-2v-3h-2v3z" />
      <path d="m17 14 5-5-1.41-1.41L18 10.17V3h-2v7.17l-2.59-2.58L12 9z" />
    </svg>
  );
}

/** Material `ios_share` — the Share glyph in Safari on macOS and iOS. */
function AppleShareIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="m16 5-1.42 1.42-1.59-1.59V16h-1.98V4.83L9.42 6.42 8 5l4-4 4 4zm4 5v11c0 1.1-.9 2-2 2H6a2 2 0 0 1-2-2V10c0-1.11.89-2 2-2h3v2H6v11h12V10h-3V8h3a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** SF-style `plus.app` — the Add to Home Screen glyph in the iOS share sheet. */
function PlusAppIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M12 8v8" />
      <path d="M8 12h8" />
    </svg>
  );
}

/** Material `tune` — Chrome's site-info button (replaced the padlock). */
function TuneIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
    </svg>
  );
}

/** Material `more_vert` — Chrome for Android's ⋮ menu button. */
function MoreVertIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
    </svg>
  );
}

/** Material `add_to_home_screen` — the icon on Chrome for Android's menu item. */
function AddToHomeScreenIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M18 1.01 8 1c-1.1 0-2 .9-2 2v3h2V5h10v14H8v-1H6v3c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM10 15h2V8H5v2h3.59L3 15.59 4.41 17 10 11.41V15z" />
    </svg>
  );
}

function AppleLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8.98-.2 1.92-.86 3.16-.77 1.79.14 3.02.86 3.71 2.17-3.31 2.03-2.5 6.13.86 7.32-.65 1.42-1.5 2.62-2.81 3.45zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

function WindowsLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <rect x="3" y="3" width="8.5" height="8.5" />
      <rect x="12.5" y="3" width="8.5" height="8.5" />
      <rect x="3" y="12.5" width="8.5" height="8.5" />
      <rect x="12.5" y="12.5" width="8.5" height="8.5" />
    </svg>
  );
}

/** Uppercase browser label inside an instructions block ("Safari", …). */
function StepLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * Instruction line with browser-UI glyphs inlined into the sentence, so the
 * icons read as references to the user's own browser chrome — not as buttons
 * in our UI that could be tapped instead.
 */
function StepHelp({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[13px] leading-[1.7] text-muted-foreground [&_svg]:mx-px [&_svg]:inline [&_svg]:size-[15px] [&_svg]:align-[-3px] [&_svg]:text-foreground">
      {children}
    </span>
  );
}

function DesktopInstallInstructions({
  target,
}: {
  target: "safari" | "chromium";
}) {
  const { t } = useTranslation();

  if (target === "safari") {
    return (
      <div className="flex flex-col gap-2.5">
        <StepLabel>{t("install.safariLabel", "Safari")}</StepLabel>
        <StepHelp>
          <Trans
            i18nKey="install.safariHelp"
            defaults="Click <shareIcon /> <bold>Share</bold> in the toolbar, then choose <bold>Add to Dock</bold>."
            components={{
              bold: <strong className="text-foreground" />,
              shareIcon: <AppleShareIcon />,
            }}
          />
        </StepHelp>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <StepLabel>
        {t("install.chromiumLabel", "Chrome · Edge · Brave")}
      </StepLabel>
      {/* Mock Chrome omnibox: a borderless filled pill with the tune
          (site-info) icon on the left and the install icon at the right end
          beside the bookmark star — mirroring the real toolbar so the
          highlighted icon is recognizable in the user's own browser. */}
      <div className="flex items-center gap-2.5 rounded-full bg-muted py-[7px] pe-2.5 ps-3.5">
        <TuneIcon className="size-[15px] shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground"
          dir="ltr"
        >
          {window.location.hostname}
        </span>
        <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-background text-primary ring-2 ring-primary">
          <InstallDesktopIcon />
        </span>
        <Star className="size-[15px] shrink-0 text-muted-foreground" />
      </div>
      <StepHelp>
        <Trans
          i18nKey="install.chromiumHelp"
          defaults="Click the highlighted <bold>install icon</bold> at the right end of the address bar, then choose <bold>Install</bold>."
          components={{ bold: <strong className="text-foreground" /> }}
        />
      </StepHelp>
    </div>
  );
}

function MobileInstallInstructions({ target }: { target: "ios" | "android" }) {
  const { t } = useTranslation();

  if (target === "ios") {
    return (
      <div className="flex flex-col gap-2.5">
        <StepLabel>{t("install.iosLabel", "iPhone · iPad (Safari)")}</StepLabel>
        <StepHelp>
          <Trans
            i18nKey="install.iosHelp"
            defaults="Tap <shareIcon /> <bold>Share</bold> in the Safari toolbar, then <bold>Add to Home Screen</bold> <plusIcon />."
            components={{
              bold: <strong className="text-foreground" />,
              shareIcon: <AppleShareIcon />,
              plusIcon: <PlusAppIcon />,
            }}
          />
        </StepHelp>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <StepLabel>{t("install.androidLabel", "Android (Chrome)")}</StepLabel>
      <StepHelp>
        <Trans
          i18nKey="install.androidHelp"
          defaults="Tap the <moreIcon /> <bold>menu</bold> in Chrome, then <bold>Add to Home screen</bold> <addIcon />."
          components={{
            bold: <strong className="text-foreground" />,
            moreIcon: <MoreVertIcon />,
            addIcon: <AddToHomeScreenIcon />,
          }}
        />
      </StepHelp>
    </div>
  );
}

function DownloadButton({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Button variant="outline" asChild>
      <a href={href} target="_blank" rel="noreferrer">
        {icon}
        {children}
      </a>
    </Button>
  );
}

/** Titled block for one install path ("Add to Home Screen", "Desktop App"…). */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function DesktopAppDownloads() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-[13px] leading-[1.55] text-muted-foreground">
        {t(
          "install.desktopIntro",
          "The desktop app keeps your notes in its own storage, fully out of the browser's reach.",
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <DownloadButton href={DOWNLOAD_LINKS.desktop} icon={<AppleLogo />}>
          {t("install.downloadMac", "Download for macOS")}
        </DownloadButton>
        <DownloadButton href={DOWNLOAD_LINKS.desktop} icon={<WindowsLogo />}>
          {t("install.downloadWindows", "Download for Windows")}
        </DownloadButton>
        <DownloadButton
          href={DOWNLOAD_LINKS.desktop}
          icon={<Terminal className="size-[15px]" />}
        >
          {t("install.downloadLinux", "Download for Linux")}
        </DownloadButton>
      </div>
    </div>
  );
}

/** Official App Store / Google Play badges (same artwork as MobileAppNudge). */
function MobileAppBadges() {
  const { t } = useTranslation();
  const base = import.meta.env.BASE_URL;
  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-[13px] leading-[1.55] text-muted-foreground">
        {t(
          "install.mobileIntro",
          "Native apps for your phone, with the same notes synced across your devices.",
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2.5">
        <a
          href={DOWNLOAD_LINKS.appStore}
          target="_blank"
          rel="noreferrer"
          className="rounded-[8px] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <img
            src={`${base}badges/app-store.svg`}
            alt={t("install.appStore", "Download on the App Store")}
            className="h-10 w-auto"
          />
        </a>
        <a
          href={DOWNLOAD_LINKS.googlePlay}
          target="_blank"
          rel="noreferrer"
          className="rounded-[8px] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <img
            src={`${base}badges/play-store.svg`}
            alt={t("install.googlePlay", "Get it on Google Play")}
            className="h-10 w-auto"
          />
        </a>
      </div>
    </div>
  );
}

/**
 * Install paths ordered by relevance to this device: the ones that apply are
 * shown expanded, the rest sit behind a "More ways to install" collapsible so
 * a phone user isn't scanning desktop instructions (and vice versa).
 */
function InstallOptions() {
  const { t } = useTranslation();
  const target = detectInstallTarget();
  const isMobileDevice = target === "ios" || target === "android";

  const webInstall = target !== "none" && (
    <Section
      title={
        isMobileDevice
          ? t("install.addToHomeScreen", "Add to Home Screen")
          : t("install.installWebApp", "Install Web App")
      }
    >
      {isMobileDevice ? (
        <MobileInstallInstructions target={target} />
      ) : (
        <DesktopInstallInstructions target={target} />
      )}
    </Section>
  );

  const desktopApp = (
    <Section title={t("install.desktopApp", "Desktop App")}>
      <DesktopAppDownloads />
    </Section>
  );

  const mobileApps = (
    <Section title={t("install.mobileApps", "Mobile Apps")}>
      <MobileAppBadges />
    </Section>
  );

  return (
    <div className="flex flex-col gap-6">
      {webInstall}
      {isMobileDevice ? mobileApps : desktopApp}
      <Accordion type="single" collapsible className="-my-2">
        <AccordionItem value="more" className="border-b-0">
          <AccordionTrigger className="py-2 text-[13px] text-muted-foreground">
            {t("install.moreOptions", "More ways to install")}
          </AccordionTrigger>
          <AccordionContent className="pt-1.5 pb-2">
            {isMobileDevice ? desktopApp : mobileApps}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

/**
 * "Protect your notes" install prompt, opened from the sidebar storage
 * banner. Web-only data lives in evictable browser storage; every section is
 * a way to move Tasfer out of that: installing the PWA, the desktop app, or
 * the native mobile apps. The sections that apply to the current device are
 * expanded; the rest are collapsed. Renders as a bottom drawer on mobile
 * viewports and a centered dialog elsewhere.
 */
export function InstallAppDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const isMobileViewport = useResponsive("(max-width: 768px)");

  if (isMobileViewport) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto flex w-full max-w-sm flex-col pb-6">
            <DrawerHeader>
              <DrawerTitle>
                {t("install.title", "Protect your notes")}
              </DrawerTitle>
              <DrawerDescription>
                {t(
                  "install.descriptionMobile",
                  "In the browser, offline support is limited and your notes sit in storage the browser may clear. The app works fully offline and keeps notes in protected storage.",
                )}
              </DrawerDescription>
            </DrawerHeader>
            <div className="flex flex-col gap-5 px-4">
              <InstallOptions />
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("install.title", "Protect your notes")}</DialogTitle>
          <DialogDescription>
            {t(
              "install.description",
              "Right now your notes sit in browser storage, which the browser may clear to free up space. Here are a few ways to protect them.",
            )}
          </DialogDescription>
        </DialogHeader>
        <InstallOptions />
      </DialogContent>
    </Dialog>
  );
}
