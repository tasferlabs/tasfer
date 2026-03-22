import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useCreateInvite, useWaitForPeer, cancelPairing } from "../api/spaces.api";
import type { SpaceInvite } from "@/platform/types";
import useResponsive from "../hooks/useResponsive";

interface InviteMembersDialogProps {
  spaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function encodeInvite(invite: SpaceInvite): string {
  return btoa(JSON.stringify(invite));
}

export function InviteMembersDialog({
  spaceId,
  open,
  onOpenChange,
}: InviteMembersDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useResponsive("(max-width: 768px)");
  const [invite, setInvite] = useState<SpaceInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<"generating" | "waiting" | "connected" | "done" | "error">("generating");
  const [errorMsg, setErrorMsg] = useState("");

  const { mutate: createInvite } = useCreateInvite({
    onSuccess: (inv) => {
      setInvite(inv);
      setStatus("waiting");
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

  // Generate invite when dialog opens
  useEffect(() => {
    if (open && spaceId) {
      setInvite(null);
      setCopied(false);
      setStatus("generating");
      setErrorMsg("");
      createInvite(spaceId);
    }
    return () => {
      // Cancel pairing when dialog closes
      cancelPairing();
    };
  }, [open, spaceId]);

  // Start waiting for peer once invite is generated
  useEffect(() => {
    if (!invite || status !== "waiting") return;

    waitForPeer({
      invite,
      callbacks: {
        onConnected: () => setStatus("connected"),
        onComplete: () => {
          setStatus("done");
          queryClient.invalidateQueries({ queryKey: ["spaces"] });
          queryClient.invalidateQueries({ queryKey: ["space-members", spaceId] });
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

  const inviteCode = invite ? encodeInvite(invite) : "";

  const content = (
    <div className="space-y-4">
      {status === "generating" && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {(status === "waiting" || status === "connected") && (
        <>
          <p className="text-sm text-muted-foreground">
            {t("space.shareInviteCode", "Share this code with the person you want to invite. They can join using the \"Join space\" option.")}
          </p>

          <div className="flex gap-2">
            <Input
              readOnly
              value={inviteCode}
              className="font-mono text-xs"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={handleCopy}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {status === "connected"
              ? t("space.peerConnected", "Peer connected, verifying...")
              : t("space.waitingForPeer", "Waiting for peer to connect...")}
          </div>
        </>
      )}

      {status === "done" && (
        <div className="text-center py-4">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 mb-3">
            <Check className="h-6 w-6 text-green-600 dark:text-green-400" />
          </div>
          <p className="text-sm font-medium">{t("space.peerJoined", "Peer joined successfully!")}</p>
        </div>
      )}

      {status === "error" && (
        <div className="text-center py-4">
          <p className="text-sm text-destructive">{errorMsg || t("common.error", "An error occurred")}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              setStatus("generating");
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
            <DrawerFooter className="pt-4">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {status === "done" ? t("common.done", "Done") : t("common.cancel", "Cancel")}
              </Button>
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
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
