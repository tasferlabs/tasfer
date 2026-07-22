import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Copy,
  FileDown,
  Info,
  Link2,
  Loader2,
  QrCode,
  UserCheck,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/ar";
import { Button } from "@/components/ui/button";
import { P2PTutorial, hasSeenP2PTutorial } from "./P2PTutorial";
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
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useCreateInvite,
  useWaitForPeer,
  cancelPairing,
  getInvite,
  getSpace,
  revokeInvite,
} from "../api/spaces.api";
import type { SpaceInvite, Peer } from "@/platform/types";
import useResponsive from "../hooks/useResponsive";
import { getDisplayName } from "@tasfer/provider-core/cursors";
import { encodeInvite, mintEphemeralInvite } from "../inviteCode";
import { downloadFile } from "@/downloadFile";

dayjs.extend(relativeTime);

interface InviteMembersDialogProps {
  spaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Joined peer shown in the list */
interface JoinedPeer {
  publicKey: string;
  name: string;
  joinedAt: number;
}

type Tab = "qr" | "code" | "file";
type Phase = "setup" | "share";

const HOUR_MS = 3_600_000;

/**
 * Backstop TTL for the QR invite. It normally dies when the dialog closes;
 * this only bounds a session whose dialog never closes.
 */
const QR_TTL_MS = HOUR_MS;

/** Lifetime options for the shareable (code/file) invite */
const INVITE_TTLS = [
  { ms: HOUR_MS, key: "share.ttl1h", fallback: "1 hour" },
  { ms: 12 * HOUR_MS, key: "share.ttl12h", fallback: "12 hours" },
  { ms: 24 * HOUR_MS, key: "share.ttl1d", fallback: "1 day" },
  { ms: 7 * 24 * HOUR_MS, key: "share.ttl7d", fallback: "7 days" },
] as const;

const DEFAULT_TTL_INDEX = 0;

/** "3nH5tQZB…MaXY" style preview of an invite code */
function shortCode(invite: SpaceInvite): string {
  const code = encodeInvite(invite);
  return `${code.slice(0, 8)}…${code.slice(-4)}`;
}

function inviteFileName(spaceName: string | null): string {
  const base = spaceName?.replace(/[\\/:*?"<>|]/g, "").trim() || "tasfer-invite";
  return `${base}.tasferinvite`;
}

export function InviteMembersDialog({
  spaceId,
  open,
  onOpenChange,
}: InviteMembersDialogProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useResponsive("(max-width: 768px)");
  const dateLocale = i18n.language?.startsWith("ar") ? "ar" : "en";

  const [showTutorial, setShowTutorial] = useState(false);
  const [phase, setPhase] = useState<Phase>("setup");
  /** Ephemeral QR invite — dies with the dialog */
  const [qrInvite, setQrInvite] = useState<SpaceInvite | null>(null);
  /** Persisted invite backing the code + file tabs — outlives the dialog */
  const [invite, setInvite] = useState<SpaceInvite | null>(null);
  /** The space's pending invite, shown in the "Active invites" section */
  const [activeInvite, setActiveInvite] = useState<SpaceInvite | null>(null);
  const [invitesOpen, setInvitesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<"idle" | "listening" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [joinedPeers, setJoinedPeers] = useState<JoinedPeer[]>([]);
  const [tab, setTab] = useState<Tab>("qr");
  const [spaceName, setSpaceName] = useState<string | null>(null);
  const [ttlIndex, setTtlIndex] = useState(DEFAULT_TTL_INDEX);
  const justJoinedRef = useRef<string | null>(null);

  const { mutate: createInvite, isPending: creating } = useCreateInvite({
    onSuccess: (inv) => {
      setInvite(inv);
      setActiveInvite(inv);
      setQrInvite(mintEphemeralInvite(spaceId, QR_TTL_MS));
      setStatus("listening");
      setPhase("share");
    },
    onError: (err) => {
      setStatus("error");
      setErrorMsg(err.message);
    },
  });

  const { mutate: waitForPeer } = useWaitForPeer({
    onError: (err) => {
      setStatus("error");
      setErrorMsg(err.message);
    },
  });

  // Reset to the setup phase each time the dialog opens and load the space's
  // pending invite for the "Active invites" section.
  useEffect(() => {
    if (open && spaceId) {
      setPhase("setup");
      setQrInvite(null);
      setInvite(null);
      setActiveInvite(null);
      setInvitesOpen(false);
      setCopied(false);
      setStatus("idle");
      setErrorMsg("");
      setJoinedPeers([]);
      setTab("qr");
      setTtlIndex(DEFAULT_TTL_INDEX);
      justJoinedRef.current = null;
      setShowTutorial(!hasSeenP2PTutorial());

      getInvite(spaceId).then(
        (existing) => setActiveInvite(existing),
        () => {},
      );
      getSpace(spaceId).then(
        (space) => setSpaceName(space.name),
        () => setSpaceName(null),
      );
    }
  }, [open, spaceId]);

  // Closing the dialog kills the QR invite; the persistent one keeps listening.
  useEffect(() => {
    if (open || !qrInvite) return;
    setQrInvite(null);
    cancelPairing(qrInvite);
  }, [open, qrInvite]);

  const peerCallbacks = useCallback(
    () => ({
      onComplete: (peer: Peer) => {
        justJoinedRef.current = peer.publicKey;
        setJoinedPeers((prev) => {
          if (prev.some((p) => p.publicKey === peer.publicKey)) return prev;
          return [...prev, { publicKey: peer.publicKey, name: peer.name, joinedAt: Date.now() }];
        });
        queryClient.invalidateQueries({ queryKey: ["spaces"] });
        queryClient.invalidateQueries({ queryKey: ["space-members", spaceId] });
        // Clear the "just joined" highlight after animation
        setTimeout(() => {
          justJoinedRef.current = null;
        }, 2000);
      },
      onError: (msg: string) => {
        setStatus("error");
        setErrorMsg(msg);
      },
    }),
    [queryClient, spaceId],
  );

  // Listen on both invites while the dialog is open
  useEffect(() => {
    if (!qrInvite || status !== "listening") return;
    waitForPeer({ invite: qrInvite, callbacks: peerCallbacks() });
  }, [qrInvite, status]);

  useEffect(() => {
    if (!invite || status !== "listening") return;
    waitForPeer({ invite, callbacks: peerCallbacks() });
  }, [invite, status]);

  const handleGenerate = useCallback(() => {
    createInvite({ spaceId, ttlMs: INVITE_TTLS[ttlIndex].ms });
  }, [createInvite, spaceId, ttlIndex]);

  const handleRevoke = useCallback(() => {
    revokeInvite(spaceId);
    setActiveInvite(null);
  }, [spaceId]);

  const handleViewActive = useCallback(() => {
    if (!activeInvite) return;
    setInvite(activeInvite);
    setQrInvite(null);
    setTab("qr");
    setStatus("listening");
    setPhase("share");
  }, [activeInvite]);

  const handleCopy = useCallback(() => {
    if (!invite) return;
    navigator.clipboard.writeText(encodeInvite(invite));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [invite]);

  const handleDownload = useCallback(async () => {
    if (!invite) return;
    await downloadFile(
      new Blob([encodeInvite(invite)], { type: "text/plain" }),
      inviteFileName(spaceName),
      "text/plain",
    );
  }, [invite, spaceName]);

  const expiresFromNow = (inv: SpaceInvite) =>
    dayjs(inv.expiresAt).locale(dateLocale).fromNow();

  const displayedQrInvite = qrInvite ?? invite;

  const sectionLabel = "text-xs font-semibold uppercase tracking-wider text-foreground";

  const setupPhase = (
    <div className="flex min-w-0 flex-col gap-5">
      {/* Expiry options */}
      <div className="flex flex-col gap-2.5">
        <span className={sectionLabel}>{t("share.expiresAfter", "Expires after")}</span>
        <div className="flex flex-wrap gap-2">
          {INVITE_TTLS.map((ttl, i) => (
            <button
              key={ttl.key}
              type="button"
              onClick={() => setTtlIndex(i)}
              className={`rounded-lg border px-3.5 py-2 text-[13px] transition-all ${
                i === ttlIndex
                  ? "border-primary bg-primary/10 font-semibold text-primary ring-2 ring-primary/15"
                  : "border-border bg-card font-medium text-foreground hover:bg-accent"
              }`}
            >
              {t(ttl.key, ttl.fallback)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2.5">
        <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs leading-normal text-muted-foreground">
          {t(
            "share.inviteCreateNote",
            "A new encrypted invite will be created for this space. You can revoke it at any time.",
          )}
        </span>
      </div>

      <div className="h-px bg-border" />

      {/* Active invites */}
      <div className="flex flex-col gap-2.5">
        <button
          type="button"
          onClick={() => setInvitesOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2.5"
        >
          <span className="flex items-center gap-2">
            <span className={sectionLabel}>{t("share.activeInvites", "Active invites")}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
              {activeInvite ? 1 : 0}
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              invitesOpen ? "rotate-180" : ""
            }`}
          />
        </button>
        {invitesOpen &&
          (activeInvite ? (
            <div className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Link2 className="h-4 w-4" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-[13px] font-medium text-foreground" dir="ltr">
                  {shortCode(activeInvite)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("share.expiresRelative", "Expires {{when}}", {
                    when: expiresFromNow(activeInvite),
                  })}
                </span>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="shrink-0">
                    {t("share.manage", "Manage")}
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={handleViewActive}>
                    {t("common.view", "View")}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={handleRevoke}>
                    {t("share.revoke", "Revoke")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <div className="rounded-lg bg-muted px-3.5 py-3 text-xs text-muted-foreground">
              {t("share.noActiveInvites", "No active invites.")}
            </div>
          ))}
      </div>

      <div className="flex justify-end gap-2.5">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t("common.cancel", "Cancel")}
        </Button>
        <Button onClick={handleGenerate} disabled={creating}>
          {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("share.createInvite", "Create invite")}
        </Button>
      </div>
    </div>
  );

  const tabs: { id: Tab; icon: typeof QrCode; label: string }[] = [
    { id: "qr", icon: QrCode, label: t("share.qrCode", "QR Code") },
    { id: "code", icon: Link2, label: t("share.inviteCode", "Invite Code") },
    { id: "file", icon: FileDown, label: t("share.fileTab", "File") },
  ];

  const sharePhase = (
    <div className="flex min-w-0 flex-col gap-5">
      {/* Tab switcher */}
      <div className="grid grid-cols-3 rounded-xl bg-muted p-[3px]">
        {tabs.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex items-center justify-center gap-1.5 rounded-[9px] border px-1.5 py-2 text-[13px] transition-all ${
              tab === id
                ? "border-border bg-card font-semibold text-foreground shadow-sm"
                : "border-transparent font-medium text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* QR Code tab */}
      {tab === "qr" && displayedQrInvite && (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-0.5">
            <span className={sectionLabel}>{t("share.scanToJoin", "Scan to join")}</span>
            <span className="text-[13px] leading-normal text-muted-foreground">
              {t("share.scanQrHint", "Scan this QR code with the Tasfer mobile app to join")}
            </span>
          </div>
          <div className="flex justify-center py-1.5">
            <div className="rounded-2xl border border-border bg-white p-3.5 shadow-sm">
              <QRCodeSVG
                value={encodeInvite(displayedQrInvite)}
                size={isMobile ? 200 : 180}
                level="M"
                bgColor="transparent"
                fgColor="#09090b"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2.5">
            <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs leading-normal text-muted-foreground">
              {qrInvite
                ? t(
                    "share.qrExpiresOnClose",
                    "This QR code stops working when you close this dialog.",
                  )
                : `${t(
                    "share.inviteStaysActive",
                    "Peers can keep joining until the invite expires, even if you close this dialog.",
                  )} ${t("share.expiresRelative", "Expires {{when}}", {
                    when: expiresFromNow(displayedQrInvite),
                  })}`}
            </span>
          </div>
        </div>
      )}

      {/* Invite code tab */}
      {tab === "code" && invite && (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-0.5">
            <span className={sectionLabel}>{t("share.inviteCode", "Invite Code")}</span>
            <span className="text-[13px] leading-normal text-muted-foreground">
              {t("share.shareCodeHint", "Share this code with people you want to invite. They can join using \"Join space\".")}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2.5 overflow-hidden rounded-xl border border-border bg-muted p-1.5 ps-3.5">
            <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" dir="ltr">
              {encodeInvite(invite)}
            </code>
            <Button variant="outline" size="sm" className="shrink-0" onClick={handleCopy}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? t("share.copied", "Copied!") : t("share.copy", "Copy")}
            </Button>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2.5">
            <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs leading-normal text-muted-foreground">
              {t("share.inviteStaysActive", "Peers can keep joining until the invite expires, even if you close this dialog.")}{" "}
              {t("share.expiresRelative", "Expires {{when}}", {
                when: expiresFromNow(invite),
              })}
            </span>
          </div>
        </div>
      )}

      {/* File tab */}
      {tab === "file" && invite && (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-0.5">
            <span className={sectionLabel}>{t("share.inviteFile", "Invite file")}</span>
            <span className="text-[13px] leading-normal text-muted-foreground">
              {t("share.saveFileHint", "Save the invite as a .tasferinvite file and send it to your peer. They can join by importing it.")}
            </span>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-border bg-muted px-3.5 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileDown className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground" dir="ltr">
                {inviteFileName(spaceName)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("share.encryptedInvite", "Encrypted invite")}
                {" · "}
                {t("share.expiresRelative", "Expires {{when}}", {
                  when: expiresFromNow(invite),
                })}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Joined peers list */}
      {joinedPeers.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className={sectionLabel}>
            {t("share.joined", "Joined")} ({joinedPeers.length})
          </span>
          <div className="flex flex-col gap-1">
            {joinedPeers.map((peer) => (
              <PeerRow
                key={peer.publicKey}
                peer={peer}
                isNew={justJoinedRef.current === peer.publicKey}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2.5">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t("common.cancel", "Cancel")}
        </Button>
        {tab === "code" && (
          <Button onClick={handleCopy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t("share.copied", "Copied!") : t("share.copyCode", "Copy invite code")}
          </Button>
        )}
        {tab === "file" && (
          <Button onClick={handleDownload}>
            <FileDown className="h-3.5 w-3.5" />
            {t("share.saveFile", "Save invite file")}
          </Button>
        )}
      </div>
    </div>
  );

  const content = (
    <div className="flex min-w-0 flex-col gap-4">
      {showTutorial && (
        <P2PTutorial
          onComplete={() => setShowTutorial(false)}
          onCancel={() => onOpenChange(false)}
          completeLabel={t("common.continue", "Continue")}
        />
      )}

      {!showTutorial && status !== "error" && (phase === "setup" ? setupPhase : sharePhase)}

      {!showTutorial && status === "error" && (
        <div className="flex flex-col items-center py-6 gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <span className="text-lg text-destructive">!</span>
          </div>
          <p className="text-sm text-destructive text-center">
            {errorMsg || t("common.error", "An error occurred")}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setInvite(null);
              setJoinedPeers([]);
              setStatus("idle");
              setPhase("setup");
            }}
          >
            {t("common.tryAgain", "Try again")}
          </Button>
        </div>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm pb-6">
            {showTutorial ? (
              <DrawerTitle className="sr-only">
                {t("share.inviteMembers", "Invite members")}
              </DrawerTitle>
            ) : (
              <DrawerHeader>
                <DrawerTitle>{t("share.inviteMembers", "Invite members")}</DrawerTitle>
              </DrawerHeader>
            )}
            <div className="px-4">{content}</div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        {showTutorial ? (
          <DialogTitle className="sr-only">
            {t("share.inviteMembers", "Invite members")}
          </DialogTitle>
        ) : (
          <DialogHeader>
            <DialogTitle>{t("share.inviteMembers", "Invite members")}</DialogTitle>
            <DialogDescription>
              {t("share.invitePeople", "Invite people to collaborate in this space")}
            </DialogDescription>
          </DialogHeader>
        )}
        {content}
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Peer row component
// -----------------------------------------------------------------------------

function PeerRow({ peer, isNew }: { peer: JoinedPeer; isNew: boolean }) {
  const { t } = useTranslation();
  const displayName = getDisplayName(peer, t("collaboration.anonymous", "Anonymous"));
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div
      className={`flex items-center gap-3 rounded-lg px-3 py-2 transition-all duration-500 ${
        isNew ? "bg-green-500/10 ring-1 ring-green-500/20" : "bg-muted/40"
      }`}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
        <p className="text-[10px] text-muted-foreground font-mono truncate">
          {peer.publicKey.slice(0, 8)}...{peer.publicKey.slice(-6)}
        </p>
      </div>
      <UserCheck className={`h-4 w-4 shrink-0 transition-colors duration-500 ${
        isNew ? "text-green-600 dark:text-green-400" : "text-muted-foreground/50"
      }`} />
    </div>
  );
}
