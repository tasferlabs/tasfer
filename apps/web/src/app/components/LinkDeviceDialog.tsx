import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Fingerprint,
  QrCode,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  cancelPairing,
  revokeDeviceLink,
  useAcceptDeviceLink,
  useCreateDeviceLink,
  waitForDevice,
} from "../api/spaces.api";
import { useAssetUrl } from "../api/images.api";
import { useAuth } from "../contexts/AuthContext";
import useMobileLayout from "../hooks/useMobileLayout";
import {
  decodeInvite,
  encodeInvite,
  isDeviceLink,
  isInviteExpired,
} from "../inviteCode";
import type { PairCallbacks, SpaceInvite } from "@/platform/types";
import {
  MAX_PAIR_RETRIES,
  isTransientPairError,
  pairErrorMessage,
  pairRetryDelay,
} from "../pairing";
import { QRScannerView } from "./QRScannerView";

interface LinkDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Short by design. For its lifetime this code grants the whole identity — every
 * space including personal ones — so it is not a link you leave lying around
 * the way a space invite can be.
 */
const LINK_TTL_MS = 10 * 60_000;

/** How long a wait stays quiet before it admits it is taking unusually long. */
const SLOW_WAIT_MS = 12_000;

type Step = "choose" | "show" | "enter" | "connecting" | "enrolling" | "done";

/** Which side of the handshake we are on, so an error returns to its own step. */
type Flow = "show" | "enter";

export function LinkDeviceDialog({ open, onOpenChange }: LinkDeviceDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { isMobile } = useMobileLayout();
  const { user } = useAuth();
  const avatarUrl = useAssetUrl(user?.avatar);

  const [step, setStep] = useState<Step>("choose");
  const [invite, setInvite] = useState<SpaceInvite | null>(null);
  const [showWhat, setShowWhat] = useState(false);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [peerName, setPeerName] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /** A wait that lost its peer says so instead of claiming to be connected. */
  const [reconnecting, setReconnecting] = useState(false);
  const [slow, setSlow] = useState(false);

  const activeInviteRef = useRef<SpaceInvite | null>(null);
  const flowRef = useRef<Flow>("show");
  /**
   * The step, readable from callbacks that outlive the render they were made
   * in — the shown code keeps listening after a link succeeds, and its expiry
   * an hour later must not drag a finished screen back to an error.
   */
  const stepRef = useRef<Step>("choose");
  stepRef.current = step;
  /** Restarts the attempt in flight — the retry needs no other context. */
  const restartRef = useRef<(() => void) | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);

  const { mutate: createLink, isPending: isCreating } = useCreateDeviceLink();
  const { mutate: acceptLink } = useAcceptDeviceLink();

  const refreshEverything = useCallback(() => {
    // A linked device adopts every space and its pages at once.
    queryClient.invalidateQueries({ queryKey: ["spaces"] });
    queryClient.invalidateQueries({ queryKey: ["pages"] });
  }, [queryClient]);

  useEffect(() => {
    if (open) {
      setStep("choose");
      setInvite(null);
      setShowWhat(false);
      setCopied(false);
      setCode("");
      setScanning(false);
      setErrorMsg("");
      setPeerName("");
      setReconnecting(false);
      setSlow(false);
      retryCount.current = 0;
    }
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      restartRef.current = null;
      const pending = activeInviteRef.current;
      if (pending) {
        activeInviteRef.current = null;
        void cancelPairing(pending);
      }
    };
  }, [open]);

  // Both waits look identical while they work, so an unusually long one has to
  // say something — otherwise a stuck handshake is indistinguishable from a
  // slow one.
  useEffect(() => {
    if (step !== "connecting" && step !== "enrolling") {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_WAIT_MS);
    return () => clearTimeout(timer);
  }, [step]);

  // Only the shown code counts down; nothing else on screen depends on the clock.
  useEffect(() => {
    if (step !== "show" || !invite) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step, invite]);

  const clearRetry = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  const failWith = useCallback(
    (code: string) => {
      if (stepRef.current === "done") return;
      clearRetry();
      setReconnecting(false);
      setStep(flowRef.current);
      setErrorMsg(pairErrorMessage(t, code));
    },
    [clearRetry, t],
  );

  /**
   * Start the attempt over after a failure that is only the network. The code
   * stays valid, so the wait keeps its screen and its spinner — nothing about
   * the flow has changed, it just has not connected yet.
   */
  const retryAttempt = useCallback(
    (code: string) => {
      if (stepRef.current === "done") return;
      const invite = activeInviteRef.current;
      const restart = restartRef.current;
      if (!invite || !restart) return failWith(code);
      if (Date.now() >= invite.expiresAt) return failWith("expired");
      if (retryCount.current >= MAX_PAIR_RETRIES) return failWith(code);

      const delay = pairRetryDelay(retryCount.current);
      retryCount.current += 1;
      setReconnecting(true);
      clearRetry();
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null;
        restart();
      }, delay);
    },
    [clearRetry, failWith],
  );

  const pairCallbacks = useCallback(
    (): PairCallbacks => ({
      onConnected: () => {
        // Reaching a peer proves the transport, so a later failure starts from
        // a clean budget rather than one spent getting here.
        retryCount.current = 0;
        clearRetry();
        setReconnecting(false);
        // A peer rejoining mid-enrolment announces itself again; the wait it
        // interrupts is a later one, so it must not be rewound.
        setStep((current) =>
          current === "enrolling" || current === "done" ? current : "connecting",
        );
      },
      onReconnecting: () => setReconnecting(true),
      onPeerIdentity: (peer: { name: string }) => setPeerName(peer.name),
      onComplete: (peer: { name: string }) => {
        setPeerName((current) => current || peer.name);
        // The handshake proves the code; the side accepting one is not linked
        // until the enrolment payload lands. Calling it done here would offer a
        // Done button that cancels the session still owed that payload, and the
        // device would keep neither the identity nor the spaces.
        if (flowRef.current === "enter") {
          setStep("enrolling");
          return;
        }
        setStep("done");
        refreshEverything();
      },
      onEnrolled: () => {
        clearRetry();
        setStep("done");
        refreshEverything();
      },
      onError: (code) => {
        if (isTransientPairError(code)) {
          retryAttempt(code);
          return;
        }
        failWith(code);
      },
    }),
    [clearRetry, failWith, refreshEverything, retryAttempt],
  );

  function handleShow() {
    flowRef.current = "show";
    setStep("show");
    setErrorMsg("");
    setCopied(false);
    setInvite(null);
    setReconnecting(false);
    retryCount.current = 0;
    clearRetry();
    createLink(
      { ttlMs: LINK_TTL_MS },
      {
        onSuccess: (created) => {
          setInvite(created);
          activeInviteRef.current = created;
          // Re-armable: listening can fail outright (offline at the moment the
          // code appears), and the code outlives that failure.
          const listen = () => {
            void waitForDevice(created, pairCallbacks()).catch(() =>
              retryAttempt("network"),
            );
          };
          restartRef.current = listen;
          listen();
        },
        onError: (err) => setErrorMsg(err.message),
      },
    );
  }

  function acceptCode(raw: string) {
    const decoded = decodeInvite(raw);
    if (!decoded) {
      setErrorMsg(t("device.invalidCode", "That code isn't valid. Check for missing characters."));
      return;
    }
    // A space invite decodes cleanly here and would only fail once pairing is
    // under way, so name the mistake and point at the flow that wants it.
    if (!isDeviceLink(decoded)) {
      setErrorMsg(
        t(
          "device.notADeviceCode",
          "That's an invite to a space, not a device code. Use it under Add space → Join space.",
        ),
      );
      return;
    }
    if (isInviteExpired(decoded)) {
      setErrorMsg(t("device.codeExpired", "This code has expired. Generate a new one."));
      return;
    }
    flowRef.current = "enter";
    setErrorMsg("");
    setStep("connecting");
    setReconnecting(false);
    activeInviteRef.current = decoded;
    retryCount.current = 0;
    clearRetry();
    // A rejected accept never reaches `callbacks.onError` — without this the
    // dialog would sit on the spinner for good.
    const attempt = () => {
      acceptLink(
        { invite: decoded, callbacks: pairCallbacks() },
        { onError: () => retryAttempt("network") },
      );
    };
    restartRef.current = attempt;
    attempt();
  }

  function handleScan(scanned: string) {
    setScanning(false);
    setCode(scanned.trim());
    acceptCode(scanned);
  }

  async function handleCopy() {
    if (!invite) return;
    await navigator.clipboard.writeText(encodeInvite(invite));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  function goBack() {
    clearRetry();
    restartRef.current = null;
    const pending = activeInviteRef.current;
    if (pending) {
      activeInviteRef.current = null;
      void cancelPairing(pending);
    }
    // Any code this device showed dies with the step that showed it, including
    // when the way out is a cancelled handshake rather than the Back button.
    if (invite) void revokeDeviceLink();
    setStep("choose");
    setInvite(null);
    setScanning(false);
    setErrorMsg("");
    setReconnecting(false);
  }

  async function handleOpenChange(next: boolean) {
    if (!next && invite && step !== "done") {
      // An abandoned code stays listenable until it expires otherwise, and this
      // one is worth more than a space invite.
      await revokeDeviceLink();
    }
    onOpenChange(next);
  }

  // What the wait says about itself, shared by the visible copy and the
  // accessible description so both tell the same story.
  const waitTitle = (label: string) =>
    reconnecting ? t("device.reconnecting", "Reconnecting…") : label;
  const waitSubtitle = reconnecting
    ? t(
        "device.reconnectingHint",
        "The connection dropped. Trying again — keep both devices open.",
      )
    : slow
      ? t(
          "device.stillTrying",
          "Still trying. Keep both devices open and on a network.",
        )
      : t("device.keepBothOpen", "Keep both devices open.");

  const remainingMs = invite ? invite.expiresAt - now : 0;
  const expired = !!invite && remainingMs <= 0;
  const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
  const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  // --- Heading (also the accessible title/description of the surface) ---

  const heading: Record<Step, { title: string; description?: string }> = {
    choose: {
      // The two buttons and "What linking does" say it better than a subtitle.
      title: t("device.title", "Link a device"),
    },
    show: {
      title: t("device.showTitle", "Scan this from your other device"),
      description: expired
        ? t("device.expiredNotice", "This code has expired.")
        : invite
          ? t("device.expiresIn", "Expires in {{time}}.", { time: clock })
          : t("device.preparingCode", "Preparing a code…"),
    },
    enter: {
      title: scanning
        ? t("device.scanTitle", "Scan the code from your other device")
        : t("device.enterTitle", "Paste the code from your other device"),
      description: t("device.enterHint", "Find it under Profile → Link a device."),
    },
    connecting: {
      title: waitTitle(t("device.connecting", "Connecting")),
      description: waitSubtitle,
    },
    enrolling: {
      title: waitTitle(t("device.enrolling", "Setting up this device")),
      description: waitSubtitle,
    },
    done: {
      title: t("device.doneTitle", "Linked"),
      description: t("device.doneDescription", "Your spaces are syncing to it now."),
    },
  };

  const Title = isMobile ? DrawerTitle : DialogTitle;
  const Description = isMobile ? DrawerDescription : DialogDescription;
  const { title, description } = heading[step];

  // Radix points the surface at its description automatically and warns when
  // that association dangles, so clear it on steps without one.
  const describedBy = description ? {} : { "aria-describedby": undefined };

  // The connecting step centres its own copy under the spinner, so the heading
  // stays only as the surface's accessible name.
  const header = (
    <div
      className={cn(
        "flex flex-col gap-1",
        (step === "connecting" || step === "enrolling") && "sr-only",
      )}
    >
      <Title className="text-[19px] font-semibold tracking-tight">{title}</Title>
      {description && (
        <Description className="text-sm text-muted-foreground">
          {description}
        </Description>
      )}
    </div>
  );

  // --- Steps ---

  const chooseStep = (
    <>
      <div className="flex flex-col gap-2">
        <Button className="w-full" onClick={handleShow} loading={isCreating}>
          {t("device.showCode", "Show a code on this device")}
        </Button>
        <Button variant="outline" className="w-full" onClick={() => setStep("enter")}>
          {t("device.enterCode", "Enter a code from another device")}
        </Button>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3.5">
        <button
          type="button"
          onClick={() => setShowWhat((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {showWhat ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5 rtl:rotate-180" />
          )}
          {t("device.whatLinkingDoes", "What linking does")}
        </button>
        {showWhat && (
          <div className="flex flex-col gap-2 ps-5 text-xs leading-relaxed text-muted-foreground">
            <p>
              {t(
                "device.intro",
                "Linked devices share one identity. Everything you have, including your personal spaces, appears on all of them, and other people see them as one person.",
              )}
            </p>
            <p>
              {t(
                "device.codeWarning",
                "Anyone who uses the code gets full access to everything you have written, until it expires.",
              )}
            </p>
          </div>
        )}
      </div>
    </>
  );

  const qrSize = isMobile ? 196 : 172;

  // QR and code together rather than behind tabs: this is a one-to-one
  // handover, so the other device should be able to take whichever it can.
  const showStep = (
    <>
      <div className="flex justify-center">
        {invite ? (
          <IdentityQR
            value={encodeInvite(invite)}
            avatarUrl={avatarUrl}
            initial={(user?.name?.trim()[0] ?? "").toUpperCase()}
            size={qrSize}
            dimmed={expired}
          />
        ) : (
          <div
            className="animate-pulse rounded-2xl bg-muted"
            style={{ width: qrSize + 28, height: qrSize + 28 }}
          />
        )}
      </div>

      <div
        dir="ltr"
        className={cn(
          "rounded-lg border border-border bg-muted px-3.5 py-3 font-mono text-[13px] leading-[1.6] tracking-[0.06em] break-all",
          expired ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {invite ? encodeInvite(invite) : "…"}
      </div>

      <div className="grid grid-flow-col auto-cols-fr gap-2">
        <Button
          variant="outline"
          className="w-full"
          onClick={handleCopy}
          disabled={!invite}
        >
          {copied ? t("common.copied", "Copied") : t("device.copyCode", "Copy code")}
        </Button>
        {expired && (
          <Button className="w-full" onClick={handleShow} loading={isCreating}>
            {t("device.newCode", "New code")}
          </Button>
        )}
      </div>

      {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}

      <div className="flex items-center justify-between border-t border-border pt-3.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
          {t("device.waiting", "Waiting for the other device")}
        </div>
        <button
          type="button"
          onClick={goBack}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("common.back", "Back")}
        </button>
      </div>
    </>
  );

  const enterStep = (
    <>
      <div className="flex flex-col gap-2">
        {scanning ? (
          <QRScannerView
            onScan={handleScan}
            onClose={() => setScanning(false)}
            hideClose
          />
        ) : (
          <Textarea
            dir="ltr"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setErrorMsg("");
            }}
            rows={2}
            autoFocus
            placeholder={t("device.codePlaceholder", "Paste the device code")}
            className={cn(
              "resize-none font-mono text-sm tracking-[0.06em] break-all",
              errorMsg && "border-destructive",
            )}
          />
        )}
        {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
        <button
          type="button"
          onClick={() => {
            setErrorMsg("");
            setScanning((v) => !v);
          }}
          className="flex items-center gap-1.5 self-start text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {scanning ? (
            <ClipboardPaste className="size-3.5" />
          ) : (
            <QrCode className="size-3.5" />
          )}
          {scanning
            ? t("device.typeInstead", "Paste the code instead")
            : t("device.scanInstead", "Scan the QR code instead")}
        </button>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3.5">
        <button
          type="button"
          onClick={goBack}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("common.back", "Back")}
        </button>
        {!scanning && (
          <Button size="sm" disabled={!code.trim()} onClick={() => acceptCode(code)}>
            {t("device.link", "Link device")}
          </Button>
        )}
      </div>
    </>
  );

  // Two waits, one shape. The second is the one that matters: the handshake is
  // done and the account is on its way over, so it says so rather than leaving
  // "Connecting" up over a connection that already succeeded.
  const waitingStep = (label: string) => (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <span className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{waitTitle(label)}</p>
        <p className="text-sm text-muted-foreground">{waitSubtitle}</p>
      </div>
      {/* A wait with no way out is the worst of the failure modes: nothing here
          finishes on its own if the other device never comes back. */}
      <button
        type="button"
        onClick={goBack}
        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {t("common.cancel", "Cancel")}
      </button>
    </div>
  );

  const doneStep = (
    <>
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted px-4 py-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3.5" />
        </span>
        <div className="flex min-w-0 flex-col">
          <p className="truncate text-sm font-medium">
            {peerName || t("device.newDevice", "New device")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("device.linkedJustNow", "Linked just now")}
          </p>
        </div>
      </div>
      <div className="flex justify-end border-t border-border pt-3.5">
        <Button size="sm" onClick={() => onOpenChange(false)}>
          {t("common.done", "Done")}
        </Button>
      </div>
    </>
  );

  const body = (
    <div className="flex flex-col gap-4">
      {header}
      {step === "choose" && chooseStep}
      {step === "show" && showStep}
      {step === "enter" && enterStep}
      {step === "connecting" &&
        waitingStep(t("device.connecting", "Connecting"))}
      {step === "enrolling" &&
        waitingStep(t("device.enrolling", "Setting up this device"))}
      {step === "done" && doneStep}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer
        open={open}
        onOpenChange={handleOpenChange}
        // A pasted code is easy to lose and tedious to get back, so the drawer
        // sits still until it is used or the step is left by the Back button.
        dirty={step === "enter" && !scanning && code.trim() !== ""}
      >
        <DrawerContent {...describedBy}>
          <div className="mx-auto w-full max-w-sm px-4 pt-4 pb-6">{body}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 sm:max-w-[460px]" {...describedBy}>
        {body}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The device code as a QR, wearing the owner's face. A space invite's QR is
 * bare, and that difference is the point: this code hands over a person, not a
 * room. The badge costs error correction, hence level "Q".
 */
function IdentityQR({
  value,
  avatarUrl,
  initial,
  size,
  dimmed,
}: {
  value: string;
  avatarUrl: string | null;
  initial: string;
  size: number;
  dimmed: boolean;
}) {
  return (
    <div
      className={cn(
        "relative rounded-2xl border border-border bg-white p-3.5 shadow-sm transition-opacity",
        dimmed && "opacity-40",
      )}
    >
      <QRCodeSVG
        value={value}
        size={size}
        level="Q"
        bgColor="transparent"
        fgColor="#09090b"
      />
      <span className="absolute inset-0 m-auto grid size-10 place-items-center overflow-hidden rounded-full border-[3px] border-white bg-zinc-900 text-sm font-semibold text-white">
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="size-full object-cover" />
        ) : initial ? (
          initial
        ) : (
          <Fingerprint className="size-4" strokeWidth={1.75} />
        )}
      </span>
    </div>
  );
}
