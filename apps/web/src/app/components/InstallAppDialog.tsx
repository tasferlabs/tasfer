import { Trans, useTranslation } from "react-i18next";
import { ChevronRight, Lock, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { detectDeviceType } from "@/platform";

/**
 * Where each "install" button points. Desktop builds ship from GitHub
 * releases; neither store listing is live yet — the Play URL already uses the
 * real application id (md.cypher.app) and the App Store URL is a placeholder
 * to swap once the listing exists.
 */
const DOWNLOAD_LINKS = {
  desktop: "https://github.com/hamza512b/cypher/releases/latest",
  appStore: "https://apps.apple.com/app/cypher",
  googlePlay: "https://play.google.com/store/apps/details?id=md.cypher.app",
};

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

function GooglePlayLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M4 3.5v17c0 .6.7 1 1.2.7l14.6-8.5c.5-.3.5-1 0-1.3L5.2 2.8C4.7 2.5 4 2.9 4 3.5z" />
    </svg>
  );
}

/** Uppercase section label inside an instructions tab ("Safari", …). */
function StepLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
      {children}
    </span>
  );
}

/** A mock browser-UI button in a step-by-step instruction row. */
function StepPill({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={
        "inline-flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-[13px] text-foreground " +
        (className ?? "")
      }
    >
      {children}
    </span>
  );
}

function StepArrow() {
  return (
    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" />
  );
}

/** Muted explainer line under a set of visual instructions. */
function StepHelp({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[13px] leading-[1.55] text-muted-foreground">
      {children}
    </span>
  );
}

function DesktopInstallInstructions() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-5 pt-3.5">
      <div className="flex flex-col gap-2.5">
        <StepLabel>
          {t("install.chromiumLabel", "Chrome · Edge · Brave")}
        </StepLabel>
        {/* Mock address bar with the install icon highlighted */}
        <div className="flex items-center gap-2 rounded-full border border-border bg-muted py-[7px] pe-2 ps-3.5">
          <Lock className="size-3 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground"
            dir="ltr"
          >
            {window.location.hostname}
          </span>
          <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] bg-background text-primary ring-2 ring-primary">
            <InstallDesktopIcon />
          </span>
        </div>
        <StepHelp>
          <Trans
            i18nKey="install.chromiumHelp"
            defaults="Click the highlighted <bold>install icon</bold> at the right end of the address bar, then choose <bold>Install</bold>."
            components={{ bold: <strong className="text-foreground" /> }}
          />
        </StepHelp>
      </div>
      <div className="flex flex-col gap-2.5">
        <StepLabel>{t("install.safariLabel", "Safari")}</StepLabel>
        <div className="flex items-center gap-2.5">
          <StepPill>
            <AppleShareIcon className="size-3.5 text-primary" />
            {t("install.share", "Share")}
          </StepPill>
          <StepArrow />
          <StepPill>{t("install.addToDock", "Add to Dock")}</StepPill>
        </div>
        <StepHelp>
          <Trans
            i18nKey="install.safariHelp"
            defaults="Click <bold>Share</bold> in the toolbar, then <bold>Add to Dock</bold>."
            components={{ bold: <strong className="text-foreground" /> }}
          />
        </StepHelp>
      </div>
    </div>
  );
}

function MobileInstallInstructions() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-5 pt-3.5">
      <div className="flex flex-col gap-2.5">
        <StepLabel>{t("install.iosLabel", "iPhone · iPad (Safari)")}</StepLabel>
        <div className="flex items-center gap-2.5">
          <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] border border-border bg-muted text-primary">
            <AppleShareIcon className="size-4" />
          </span>
          <StepArrow />
          <StepPill className="rounded-[9px] px-3">
            {t("install.addToHomeScreenIos", "Add to Home Screen")}
            <PlusAppIcon className="size-[15px] text-muted-foreground" />
          </StepPill>
        </div>
        <StepHelp>
          <Trans
            i18nKey="install.iosHelp"
            defaults="Tap <bold>Share</bold> in the Safari toolbar, then <bold>Add to Home Screen</bold>."
            components={{ bold: <strong className="text-foreground" /> }}
          />
        </StepHelp>
      </div>
      <div className="flex flex-col gap-2.5">
        <StepLabel>{t("install.androidLabel", "Android (Chrome)")}</StepLabel>
        <div className="flex items-center gap-2.5">
          <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] border border-border bg-muted text-foreground">
            <MoreVertIcon className="size-4" />
          </span>
          <StepArrow />
          <StepPill className="rounded-[9px] px-3">
            {t("install.addToHomeScreenAndroid", "Add to Home screen")}
            <AddToHomeScreenIcon className="size-[15px] text-muted-foreground" />
          </StepPill>
        </div>
        <StepHelp>
          <Trans
            i18nKey="install.androidHelp"
            defaults="Tap the <bold>⋮ menu</bold> in Chrome, then <bold>Add to Home screen</bold>."
            components={{ bold: <strong className="text-foreground" /> }}
          />
        </StepHelp>
      </div>
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

/**
 * "Protect your notes" install dialog, opened from the sidebar storage
 * banner. Web-only data lives in evictable browser storage; every tab of this
 * dialog is a way to move Cypher out of that: installing the PWA, the desktop
 * app, or the native mobile apps. The first tab adapts to the device — PWA
 * install steps on desktop, Add-to-Home-Screen steps on phones and tablets.
 */
export function InstallAppDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const deviceType = detectDeviceType();
  const isMobile = deviceType === "phone" || deviceType === "tablet";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("install.title", "Protect your notes")}</DialogTitle>
          <DialogDescription>
            {t(
              "install.description",
              "Right now your encrypted notes sit in browser storage, which the browser may clear to free up space. Installing Cypher moves them to protected storage.",
            )}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="install">
          <TabsList className="w-full">
            <TabsTrigger value="install">
              {isMobile
                ? t("install.tabInstallMobile", "Add to Home Screen")
                : t("install.tabInstallDesktop", "Install Web App")}
            </TabsTrigger>
            <TabsTrigger value="desktop">
              {t("install.tabDesktop", "Desktop App")}
            </TabsTrigger>
            <TabsTrigger value="mobile">
              {t("install.tabMobile", "Mobile Apps")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="install">
            {isMobile ? (
              <MobileInstallInstructions />
            ) : (
              <DesktopInstallInstructions />
            )}
          </TabsContent>

          <TabsContent value="desktop">
            <div className="flex flex-col gap-4 pt-3.5">
              <p className="text-[13px] leading-[1.55] text-muted-foreground">
                {t(
                  "install.desktopIntro",
                  "The strongest protection — the desktop app keeps your encrypted notes in its own storage, fully out of the browser's reach.",
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <DownloadButton
                  href={DOWNLOAD_LINKS.desktop}
                  icon={<AppleLogo />}
                >
                  {t("install.downloadMac", "Download for macOS")}
                </DownloadButton>
                <DownloadButton
                  href={DOWNLOAD_LINKS.desktop}
                  icon={<WindowsLogo />}
                >
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
          </TabsContent>

          <TabsContent value="mobile">
            <div className="flex flex-col gap-4 pt-3.5">
              <p className="text-[13px] leading-[1.55] text-muted-foreground">
                {t(
                  "install.mobileIntro",
                  "Native apps for your phone, with the same end-to-end encrypted sync between your devices.",
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <DownloadButton
                  href={DOWNLOAD_LINKS.appStore}
                  icon={<AppleLogo />}
                >
                  {t("install.appStore", "Download on the App Store")}
                </DownloadButton>
                <DownloadButton
                  href={DOWNLOAD_LINKS.googlePlay}
                  icon={<GooglePlayLogo />}
                >
                  {t("install.googlePlay", "Get it on Google Play")}
                </DownloadButton>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
          <Lock className="size-[13px] shrink-0 text-primary" />
          {t(
            "install.footerNote",
            "Your notes stay end-to-end encrypted on your device — installing only protects them from browser cleanup.",
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
