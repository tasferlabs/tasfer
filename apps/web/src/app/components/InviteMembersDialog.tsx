import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Check,
  Copy,
  Link2,
  Loader2,
  QrCode,
  UserCheck,
  Users,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
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
import { useCreateInvite, useWaitForPeer, cancelPairing } from "../api/spaces.api";
import type { SpaceInvite, Peer } from "@/platform/types";
import useResponsive from "../hooks/useResponsive";
import { getDisplayName } from "@cypherkit/provider-core/cursors";

interface InviteMembersDialogProps {
  spaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

/** Pack topic (32B) + secret (32B) + spaceId (16B) = 80 bytes → base64 (108 chars) */
function encodeInvite(invite: SpaceInvite): string {
  const bytes = new Uint8Array(80);
  bytes.set(hexToBytes(invite.topic), 0);
  bytes.set(hexToBytes(invite.secret), 32);
  bytes.set(new TextEncoder().encode(invite.spaceId).subarray(0, 16), 64);
  return btoa(String.fromCharCode(...bytes));
}

/** Joined peer shown in the list */
interface JoinedPeer {
  publicKey: string;
  name: string;
  joinedAt: number;
}

type Tab = "qr" | "link";

export function InviteMembersDialog({
  spaceId,
  open,
  onOpenChange,
}: InviteMembersDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useResponsive("(max-width: 768px)");

  const [showTutorial, setShowTutorial] = useState(false);
  const [invite, setInvite] = useState<SpaceInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<"generating" | "listening" | "error">("generating");
  const [errorMsg, setErrorMsg] = useState("");
  const [joinedPeers, setJoinedPeers] = useState<JoinedPeer[]>([]);
  const [tab, setTab] = useState<Tab>("qr");
  const justJoinedRef = useRef<string | null>(null);

  const { mutate: createInvite } = useCreateInvite({
    onSuccess: (inv) => {
      setInvite(inv);
      setStatus("listening");
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

  // Generate invite when dialog opens (or show tutorial first)
  useEffect(() => {
    if (open && spaceId) {
      setInvite(null);
      setCopied(false);
      setStatus("generating");
      setErrorMsg("");
      setJoinedPeers([]);
      setTab("qr");
      justJoinedRef.current = null;

      if (!hasSeenP2PTutorial()) {
        setShowTutorial(true);
      } else {
        setShowTutorial(false);
        createInvite(spaceId);
      }
    }
    return () => {
      cancelPairing();
    };
  }, [open, spaceId]);

  const handleTutorialComplete = useCallback(() => {
    setShowTutorial(false);
    createInvite(spaceId);
  }, [spaceId, createInvite]);

  // Start listening for peers (multi-peer mode)
  useEffect(() => {
    if (!invite || status !== "listening") return;

    waitForPeer({
      invite,
      callbacks: {
        multi: true,
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
        onError: (msg) => {
          setStatus("error");
          setErrorMsg(msg);
        },
      },
    });
  }, [invite, status]);

  const handleCopy = useCallback(() => {
    if (!invite) return;
    navigator.clipboard.writeText(encodeInvite(invite));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [invite]);

  const handleStopSharing = useCallback(() => {
    cancelPairing();
    onOpenChange(false);
  }, [onOpenChange]);

  const inviteCode = invite ? encodeInvite(invite) : "";

  const content = (
    <div className="flex flex-col gap-4">
      {showTutorial && (
        <P2PTutorial onComplete={handleTutorialComplete} />
      )}

      {!showTutorial && status === "generating" && (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {t("share.generating", "Generating invite...")}
          </p>
        </div>
      )}

      {!showTutorial && status === "listening" && (
        <>
          {/* Tab switcher */}
          <div className="flex rounded-lg bg-muted p-1 gap-1">
            <button
              type="button"
              onClick={() => setTab("qr")}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                tab === "qr"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <QrCode className="h-3.5 w-3.5" />
              {t("share.qrCode", "QR Code")}
            </button>
            <button
              type="button"
              onClick={() => setTab("link")}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                tab === "link"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Link2 className="h-3.5 w-3.5" />
              {t("share.inviteCode", "Invite Code")}
            </button>
          </div>

          {/* QR Code tab */}
          {tab === "qr" && (
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
                <QRCodeSVG
                  value={inviteCode}
                  size={isMobile ? 200 : 180}
                  level="M"
                  bgColor="transparent"
                  fgColor="#09090b"
                />
              </div>
              <p className="text-xs text-muted-foreground text-center max-w-[260px]">
                {t("share.scanQrHint", "Scan this QR code with the Cypher mobile app to join")}
              </p>
            </div>
          )}

          {/* Invite code tab */}
          {tab === "link" && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                {t("share.shareCodeHint", "Share this code with people you want to invite. They can join using \"Join space\".")}
              </p>
              <div
                className="relative cursor-pointer rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs break-all select-all leading-relaxed transition-colors hover:border-primary/30"
                onClick={handleCopy}
              >
                {inviteCode}
                <div className="absolute end-2 top-2">
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Copy button (always visible) */}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleCopy}
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                {t("share.copied", "Copied!")}
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                {t("share.copyCode", "Copy invite code")}
              </>
            )}
          </Button>

          {/* Joined peers list */}
          {joinedPeers.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 mb-1">
                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">
                  {t("share.joined", "Joined")} ({joinedPeers.length})
                </span>
              </div>
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

          {/* Listening + stop sharing */}
          <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            <span className="flex-1 text-xs font-medium text-muted-foreground">
              {t("share.listeningForPeers", "Listening for peers...")}
            </span>
            <button
              type="button"
              onClick={handleStopSharing}
              className="rounded-md px-2 py-0.5 text-[11px] font-medium text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              {t("share.stopSharing", "Stop sharing")}
            </button>
          </div>
        </>
      )}

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
              setStatus("generating");
              setJoinedPeers([]);
              createInvite(spaceId);
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
            <DrawerHeader>
              <DrawerTitle>{t("share.inviteMembers", "Invite members")}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4">{content}</div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t("share.inviteMembers", "Invite members")}</DialogTitle>
          <DialogDescription>
            {t("share.invitePeople", "Invite people to collaborate in this space")}
          </DialogDescription>
        </DialogHeader>
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
