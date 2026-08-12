import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { normalizeLinkUrl } from "@tasfer/editor";
import { Globe, Mail, Phone } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invariant } from "@shared/invariant";
import { getBridge } from "@/platform/bridge";
import useMobileLayout from "../hooks/useMobileLayout";
import { useToast } from "./Toast";

/**
 * External-link confirmation — the single way the app leaves itself for a URL
 * that came out of a document.
 *
 * A link's url is untrusted content: it can arrive from an imported file, a
 * paste, or a peer editing a shared space. Two gates apply before anything
 * opens. The engine's protocol allowlist rejects schemes that would run in our
 * origin or hand the document control of another app; what survives is shown to
 * the user — destination first — so leaving the app is always a deliberate act
 * rather than a side effect of a click.
 */

interface ExternalLinkContextValue {
  /**
   * Validate `rawUrl` and, if the scheme is allowed, ask the user to confirm
   * before opening it. Rejected urls surface a toast and open nothing.
   */
  openExternalUrl: (rawUrl: string) => void;
}

const ExternalLinkContext = createContext<ExternalLinkContextValue | undefined>(
  undefined,
);

interface Destination {
  /** The address up to the target: scheme, and any credentials. */
  prefix: string;
  /** Host, or recipient for mailto:/tel: — the part that decides the outcome. */
  target: string;
  /** Path, query and fragment, which say nothing about where the link lands. */
  suffix: string;
  kind: "web" | "email" | "phone";
}

/**
 * Split a normalized url into the part a reader has to check and the parts that
 * only look like it. Credentials are the reason this is a split rather than a
 * lookup: `https://tasfer.app@evil.example/` reads as ours until the host is
 * told apart from everything before it. Nothing is dropped or decoded — the
 * address is shown exactly as it will be opened.
 */
function describeDestination(url: string): Destination {
  const whole: Destination = { prefix: "", target: url, suffix: "", kind: "web" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return whole;
  }

  // mailto:/tel: carry the recipient in the path rather than a host.
  if (parsed.protocol === "mailto:" || parsed.protocol === "tel:") {
    return {
      prefix: parsed.protocol,
      target: parsed.pathname,
      suffix: parsed.search + parsed.hash,
      kind: parsed.protocol === "mailto:" ? "email" : "phone",
    };
  }

  const credentials = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
    : "";
  const prefix = `${parsed.protocol}//${credentials}`;
  // Serialization we don't predict is shown whole rather than highlighted wrong.
  if (!url.startsWith(prefix + parsed.host)) return whole;

  return {
    prefix,
    target: parsed.host,
    suffix: url.slice(prefix.length + parsed.host.length),
    kind: "web",
  };
}

const DESTINATION_ICON = { web: Globe, email: Mail, phone: Phone } as const;

/** The address, with the host set apart, above what opening it will do. */
function DestinationCard({ url }: { url: string }) {
  const { t } = useTranslation();
  const { prefix, target, suffix, kind } = describeDestination(url);
  const Icon = DESTINATION_ICON[kind];

  const outcome = {
    web: t("editor.link.opensInBrowser", "Opens in your browser"),
    email: t("editor.link.opensEmail", "Starts a new email"),
    phone: t("editor.link.opensCall", "Starts a phone call"),
  }[kind];

  return (
    <div className="border-border bg-muted/40 rounded-lg border px-3.5 py-3">
      <p
        // An address reads left to right in every locale, and monospace keeps
        // look-alike characters (rn/m, l/I) apart at a glance.
        dir="ltr"
        className="text-muted-foreground max-h-24 overflow-y-auto font-mono text-sm/6 break-all text-start"
      >
        {prefix}
        <span className="text-foreground font-medium">{target}</span>
        {suffix}
      </p>
      <p className="text-muted-foreground mt-2.5 flex items-center gap-1.5 text-xs">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {outcome}
      </p>
    </div>
  );
}

export function ExternalLinkProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { isMobile } = useMobileLayout();
  // The normalized url awaiting confirmation, kept separately from `open` so the
  // dialog keeps its text through the close animation.
  const [pending, setPending] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const openExternalUrl = useCallback(
    (rawUrl: string) => {
      const safe = normalizeLinkUrl(rawUrl);
      if (!safe) {
        toast.error(
          t(
            "editor.link.blockedUrl",
            "This link was blocked. Only web, email, and phone links can be opened.",
          ),
        );
        return;
      }
      setPending(safe);
      setOpen(true);
    },
    [t, toast],
  );

  const confirm = useCallback(() => {
    setOpen(false);
    if (!pending) return;
    // Native shells route through their own scheme check and hand off to the OS
    // browser; plain web and Electron open a new tab, severed from this window.
    const bridge = getBridge();
    if (bridge) {
      void bridge.navigation.openUrl(pending);
    } else {
      window.open(pending, "_blank", "noopener,noreferrer");
    }
  }, [pending]);

  const value = useMemo<ExternalLinkContextValue>(
    () => ({ openExternalUrl }),
    [openExternalUrl],
  );

  const title = t("editor.link.confirmOpenTitle", "Open this link?");
  const description = t(
    "editor.link.confirmOpenDescription",
    "Anyone who can edit this page can change where its links go.",
  );
  const cancelLabel = t("common.cancel", "Cancel");
  const openLabel = t("editor.link.openLink", "Open link");

  return (
    <ExternalLinkContext.Provider value={value}>
      {children}
      {isMobile ? (
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent>
            <div className="mx-auto flex w-full max-w-sm flex-1 flex-col">
              <DrawerHeader>
                <DrawerTitle>{title}</DrawerTitle>
                <DrawerDescription>{description}</DrawerDescription>
              </DrawerHeader>
              <div className="px-4">
                {pending && <DestinationCard url={pending} />}
              </div>
              <DrawerFooter>
                <Button onClick={confirm}>{openLabel}</Button>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  {cancelLabel}
                </Button>
              </DrawerFooter>
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{title}</AlertDialogTitle>
              <AlertDialogDescription>{description}</AlertDialogDescription>
            </AlertDialogHeader>

            {pending && <DestinationCard url={pending} />}

            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setOpen(false)}>
                {cancelLabel}
              </AlertDialogCancel>
              <AlertDialogAction onClick={confirm}>
                {openLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </ExternalLinkContext.Provider>
  );
}

/** Open a document-supplied url behind the confirmation dialog. */
export function useOpenExternalUrl(): (rawUrl: string) => void {
  const context = useContext(ExternalLinkContext);
  invariant(
    context,
    "useOpenExternalUrl must be used within an ExternalLinkProvider",
  );
  return context.openExternalUrl;
}
