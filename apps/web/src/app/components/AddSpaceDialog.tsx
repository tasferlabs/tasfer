import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
} from "@/components/ui/drawer";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { SpaceInvite } from "@/platform/types";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Globe,
  Link2,
  Loader2,
  Plus,
  QrCode,
  Shield,
  UserPlus,
  Users,
  WifiOff,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { cancelPairing, useAcceptInvite, useCreateSpace } from "../api/spaces.api";
import useResponsive from "../hooks/useResponsive";
import { QRScannerView } from "./QRScannerView";

interface AddSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type View = "pick" | "create" | "join";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Unpack 80 bytes: topic (32B) + secret (32B) + spaceId (16B) */
function decodeInvite(code: string): SpaceInvite | null {
  try {
    const str = atob(code.trim());
    if (str.length !== 80) return null;
    const bytes = new Uint8Array(80);
    for (let i = 0; i < 80; i++) bytes[i] = str.charCodeAt(i);
    const topic = bytesToHex(bytes.subarray(0, 32));
    const secret = bytesToHex(bytes.subarray(32, 64));
    const h = bytesToHex(bytes.subarray(64, 80));
    const spaceId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    return { topic, secret, spaceId };
  } catch {
    return null;
  }
}

export function AddSpaceDialog({ open, onOpenChange }: AddSpaceDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useResponsive("(max-width: 768px)");
  const [view, setView] = useState<View>("pick");

  // --- Create space ---
  const CreateSchema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .min(1, t("validation.spaceNameRequired", "Space name is required"))
          .min(3, t("validation.spaceNameTooShort", "Space name is too short"))
          .max(50, t("validation.spaceNameTooLong", "Space name is too long")),
      }),
    [t],
  );

  const createForm = useForm<z.infer<typeof CreateSchema>>({
    resolver: zodResolver(CreateSchema),
    defaultValues: { name: "" },
  });

  const { mutate: createSpace, isPending: isCreating } = useCreateSpace({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
      onOpenChange(false);
    },
  });

  function handleCreate(data: z.infer<typeof CreateSchema>) {
    createSpace({ name: data.name });
  }

  // --- Join space ---
  const JoinSchema = useMemo(
    () =>
      z.object({
        code: z.string().min(1, t("validation.required", "Required")).refine(
          (val) => decodeInvite(val) !== null,
          t("space.invalidInviteCode", "Invalid invite code"),
        ),
      }),
    [t],
  );

  const joinForm = useForm<z.infer<typeof JoinSchema>>({
    resolver: zodResolver(JoinSchema),
    defaultValues: { code: "" },
  });

  const [joinStatus, setJoinStatus] = useState<"input" | "connecting" | "done" | "error">("input");
  const [joinTab, setJoinTab] = useState<"code" | "scan">("code");
  const [spaceName, setSpaceName] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const { mutate: acceptInvite } = useAcceptInvite({
    onError: (err) => {
      setJoinStatus("error");
      setErrorMsg(err.message);
    },
  });

  function handleJoin(data: z.infer<typeof JoinSchema>) {
    const invite = decodeInvite(data.code);
    if (!invite) return;

    setJoinStatus("connecting");

    acceptInvite({
      invite,
      callbacks: {
        onConnected: () => {},
        onComplete: (_peer, name) => {
          if (name) setSpaceName(name);
          setJoinStatus("done");
          queryClient.invalidateQueries({ queryKey: ["spaces"] });
          queryClient.invalidateQueries({ queryKey: ["pages"] });
        },
        onError: (msg) => {
          setJoinStatus("error");
          setErrorMsg(msg);
        },
      },
    });
  }

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      createForm.reset();
      joinForm.reset();
      setView("pick");
      setJoinStatus("input");
      setJoinTab("code");
      setSpaceName("");
      setErrorMsg("");
    }
    return () => {
      cancelPairing();
    };
  }, [open]);

  // Can go back only when not mid-connection
  const canGoBack = view !== "pick";

  function goBack() {
    if (joinStatus === "done") {
      onOpenChange(false);
      return;
    }
    setView("pick");
    setJoinStatus("input");
    setErrorMsg("");
  }

  // --- Views ---

  const pickView = (
    <div className="flex flex-col gap-4">
      {/* Option cards */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setView("create")}
          className="group flex items-center gap-3 rounded-lg border border-border p-3.5 text-start transition-colors hover:border-primary/40 hover:bg-primary/5"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
            <Plus className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              {t("space.createNewSpace", "Create new space")}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("space.createNewSpaceDesc", "Create a new space to organize your pages")}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
        </button>

        <button
          type="button"
          onClick={() => setView("join")}
          className="group flex items-center gap-3 rounded-lg border border-border p-3.5 text-start transition-colors hover:border-primary/40 hover:bg-primary/5"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
            <UserPlus className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              {t("space.joinSpace", "Join space")}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("space.joinSpaceDesc", "Use an invite code from someone you trust")}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
        </button>
      </div>

      {/* How spaces work */}
      <div className="rounded-lg bg-muted/50 p-3 flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground mb-0.5">
          {t("space.howSpacesWork", "How spaces work")}
        </p>
        <SpaceRule
          icon={Users}
          text={t("space.ruleAllMembers", "All members can see and edit every page in the space.")}
        />
        <SpaceRule
          icon={Globe}
          text={t("space.ruleP2P", "Pages sync directly between devices — peer-to-peer, no cloud.")}
        />
        <SpaceRule
          icon={WifiOff}
          text={t("space.ruleOffline", "Works offline. Changes merge automatically when you reconnect.")}
        />
        <SpaceRule
          icon={Shield}
          text={t("space.rulePrivate", "Your data lives on your devices and syncs over a peer-to-peer connection.")}
        />
      </div>
    </div>
  );

  const createView = (
    <Form {...createForm}>
      <form onSubmit={createForm.handleSubmit(handleCreate)} className="flex flex-col gap-4">
        <FormField
          control={createForm.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("space.spaceName", "Space name")}</FormLabel>
              <Input
                {...field}
                placeholder={t("space.spaceNamePlaceholder", "My workspace")}
                autoFocus
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <p className="text-xs text-muted-foreground">
          {t("space.createSpaceNote", "You'll be the only member. You can invite others later from space settings.")}
        </p>

        <Button type="submit" className="w-full" loading={isCreating}>
          {t("space.createNewSpace", "Create new space")}
        </Button>
      </form>
    </Form>
  );

  function handleQrScan(data: string) {
    const invite = decodeInvite(data);
    if (!invite) {
      setJoinStatus("error");
      setErrorMsg(t("space.invalidInviteCode", "Invalid invite code"));
      return;
    }
    setJoinStatus("connecting");
    acceptInvite({
      invite,
      callbacks: {
        onConnected: () => {},
        onComplete: (_peer, name) => {
          if (name) setSpaceName(name);
          setJoinStatus("done");
          queryClient.invalidateQueries({ queryKey: ["spaces"] });
          queryClient.invalidateQueries({ queryKey: ["pages"] });
        },
        onError: (msg) => {
          setJoinStatus("error");
          setErrorMsg(msg);
        },
      },
    });
  }

  const joinInputView = (
    <div className="flex flex-col gap-4">
      {/* Tab switcher */}
      <div className="flex rounded-lg bg-muted p-1 gap-1">
        <button
          type="button"
          onClick={() => setJoinTab("code")}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
            joinTab === "code"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Link2 className="h-3.5 w-3.5" />
          {t("share.inviteCode", "Invite Code")}
        </button>
        <button
          type="button"
          onClick={() => setJoinTab("scan")}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
            joinTab === "scan"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <QrCode className="h-3.5 w-3.5" />
          {t("scanner.scanQR", "Scan QR")}
        </button>
      </div>

      {/* Invite code tab */}
      {joinTab === "code" && (
        <Form {...joinForm}>
          <form onSubmit={joinForm.handleSubmit(handleJoin)} className="flex flex-col gap-4">
            <p className="text-xs text-muted-foreground">
              {t("space.joinSpaceNote", "By joining, you'll share all pages in this space with its members. Only join spaces from people you trust.")}
            </p>

            <FormField
              control={joinForm.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("space.inviteCode", "Invite code")}</FormLabel>
                  <Textarea
                    {...field}
                    placeholder={t("space.pasteCodeHere", "Paste code here...")}
                    rows={3}
                    autoFocus
                    className="font-mono text-xs break-all"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="submit" className="w-full">
              {t("space.joinSpace", "Join space")}
            </Button>
          </form>
        </Form>
      )}

      {/* QR Scanner tab */}
      {joinTab === "scan" && (
        <QRScannerView
          onScan={handleQrScan}
          onClose={() => setJoinTab("code")}
        />
      )}
    </div>
  );

  function handleCancelJoin() {
    cancelPairing();
    setJoinStatus("input");
    setSpaceName("");
  }

  const joinConnectingView = (
    <div className="flex flex-col items-center py-6 gap-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium">
          {t("space.connecting", "Connecting...")}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {t("space.waitingForPeer", "Waiting for peer to connect...")}
        </p>
      </div>
      <Button variant="outline" size="sm" className="mt-1" onClick={handleCancelJoin}>
        {t("common.cancel", "Cancel")}
      </Button>
    </div>
  );

  const joinDoneView = (
    <div className="flex flex-col items-center py-6 gap-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
        <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
      </div>
      <p className="text-sm font-medium text-center">
        {t("space.joinedSpace", 'Joined "{{name}}" successfully!', { name: spaceName })}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-1"
        onClick={() => onOpenChange(false)}
      >
        {t("common.done", "Done")}
      </Button>
    </div>
  );

  const joinErrorView = (
    <div className="flex flex-col items-center py-6 gap-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <span className="text-lg text-destructive">!</span>
      </div>
      <p className="text-sm text-destructive text-center">
        {errorMsg || t("common.error", "An error occurred")}
      </p>
      <Button variant="outline" size="sm" onClick={() => setJoinStatus("input")}>
        {t("common.tryAgain", "Try again")}
      </Button>
    </div>
  );

  const joinView =
    joinStatus === "input" ? joinInputView
    : joinStatus === "connecting" ? joinConnectingView
    : joinStatus === "done" ? joinDoneView
    : joinErrorView;

  // --- Header ---
  const title =
    view === "pick" ? t("space.addSpace", "Add space")
    : view === "create" ? t("space.createNewSpace", "Create new space")
    : t("space.joinSpace", "Join space");

  const header = (
    <div className="flex items-center gap-2 pb-1">
      {canGoBack && (
        <button
          type="button"
          onClick={goBack}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />
        </button>
      )}
      <h2 className="text-lg font-medium text-foreground">{title}</h2>
    </div>
  );

  const body = view === "pick" ? pickView : view === "create" ? createView : joinView;

  // --- Render ---
  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm px-4 pb-6 pt-4">
            {header}
            <div className="mt-4">{body}</div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px] p-5 gap-0">
        {header}
        <div className="mt-4">{body}</div>
      </DialogContent>
    </Dialog>
  );
}

function SpaceRule({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="flex items-start gap-2 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary/60" />
      <span>{text}</span>
    </div>
  );
}
