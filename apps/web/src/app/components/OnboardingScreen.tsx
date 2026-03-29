import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
  ArrowRight,
  Camera,
  Check,
  ChevronRight,
  Eye,
  Fingerprint,
  Globe,
  Loader2,
  Lock,
  Plus,
  QrCode,
  Shield,
  UserPlus,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { updateProfile } from "../api/auth.api";
import { uploadImage, useAssetUrl } from "../api/images.api";
import {
  cancelPairing,
  useAcceptInvite,
  useCreateSpace,
} from "../api/spaces.api";
import { useAuth } from "../contexts/AuthContext";
import useResponsive from "../hooks/useResponsive";
import { AvatarCropDialog } from "./AvatarCropDialog";
import { QRScannerView } from "./QRScannerView";

type Step = "profile" | "identity" | "space";
type SpaceView = "pick" | "create" | "join";

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

export function OnboardingScreen() {
  const { user } = useAuth();

  // Skip profile step if name is already set
  const initialStep: Step = user?.name ? "identity" : "profile";
  const [step, setStep] = useState<Step>(initialStep);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      {/* Electron: fixed drag region at top so the window can be moved */}
      <div
        className="fixed inset-x-0 top-0 h-12 z-50"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />
      <div className="w-full max-w-md">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {(["profile", "identity", "space"] as const).map((s) => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                s === step
                  ? "w-6 bg-primary"
                  : ["profile", "identity", "space"].indexOf(s) <
                      ["profile", "identity", "space"].indexOf(step)
                    ? "w-1.5 bg-primary/40"
                    : "w-1.5 bg-border"
              }`}
            />
          ))}
        </div>

        {step === "profile" && (
          <ProfileStep onNext={() => setStep("identity")} />
        )}
        {step === "identity" && (
          <IdentityStep
            onNext={() => setStep("space")}
            onBack={() => setStep("profile")}
          />
        )}
        {step === "space" && <SpaceStep onBack={() => setStep("identity")} />}
      </div>
    </div>
  );
}

// ─── Profile Step ───────────────────────────────────────────

function ProfileStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  const { user, updateUser } = useAuth();

  const [name, setName] = useState(user?.name ?? "");
  const [avatarId, setAvatarId] = useState<string | null>(user?.avatar ?? null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const avatarUrl = useAssetUrl(avatarId);

  async function handleCropped(croppedFile: File) {
    setPendingFile(null);
    try {
      setUploading(true);
      const image = await uploadImage(croppedFile);
      setAvatarId(image.id);
    } catch (err) {
      console.error("Failed to upload avatar:", err);
    } finally {
      setUploading(false);
    }
  }

  async function handleNext() {
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
      setSaving(true);
      const updated = await updateProfile({
        name: trimmed,
        avatar: avatarId,
      });
      updateUser(updated);
      onNext();
    } catch (err) {
      console.error("Failed to save profile:", err);
    } finally {
      setSaving(false);
    }
  }

  const initials = name.trim() ? name.trim().charAt(0).toUpperCase() : "?";

  return (
    <div className="flex flex-col items-center">
      <h1 className="text-2xl font-semibold text-foreground text-center">
        {t("onboarding.welcome", "Welcome to Cypher")}
      </h1>
      <p className="text-sm text-muted-foreground mt-2 text-center max-w-xs">
        {t(
          "onboarding.profileDesc",
          "Set up your profile. This is only visible to people you collaborate with in shared spaces.",
        )}
      </p>

      {/* Avatar */}
      <div className="mt-8 mb-6">
        <div
          className="relative w-24 h-24 rounded-full overflow-hidden cursor-pointer group"
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
        >
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-primary/10 text-primary text-3xl font-semibold">
              {initials}
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity text-white">
            <Camera className="h-5 w-5" />
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) setPendingFile(file);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
          hidden
        />
      </div>

      {/* Name input */}
      <div className="w-full max-w-xs">
        <label className="text-sm font-medium text-foreground mb-1.5 block">
          {t("onboarding.yourName", "Your name")}
        </label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("profile.enterName", "Enter your name")}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) handleNext();
          }}
        />
      </div>

      <Button
        className="w-full max-w-xs mt-6"
        onClick={handleNext}
        disabled={!name.trim()}
        loading={saving || uploading}
      >
        {t("common.continue", "Continue")}
        <ArrowRight className="h-4 w-4 ms-1 rtl:-scale-x-100" />
      </Button>

      <AvatarCropDialog
        file={pendingFile}
        onCropped={handleCropped}
        onCancel={() => setPendingFile(null)}
      />
    </div>
  );
}

// ─── Identity Step ──────────────────────────────────────────

function IdentityStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();

  // Truncate public key for display
  const publicKey = user?.id ?? "";
  const shortKey =
    publicKey.length > 16
      ? `${publicKey.slice(0, 8)}...${publicKey.slice(-8)}`
      : publicKey;

  const features = [
    {
      icon: Fingerprint,
      title: t("onboarding.identityUnique", "Unique to this device"),
      desc: t(
        "onboarding.identityUniqueDesc",
        "A cryptographic keypair was generated on your device. It identifies you without accounts or passwords.",
      ),
    },
    {
      icon: Eye,
      title: t("onboarding.identityVisible", "Visible only in spaces"),
      desc: t(
        "onboarding.identityVisibleDesc",
        "Your name and avatar are shared only with people in your spaces. Nobody else can see them.",
      ),
    },
    {
      icon: Lock,
      title: t("onboarding.identityLocal", "Stays on your device"),
      desc: t(
        "onboarding.identityLocalDesc",
        "Your private key never leaves this device. There is no server that stores your identity.",
      ),
    },
  ];

  return (
    <div className="flex flex-col items-center">
      {/* Hero visual — key icon with glow ring */}
      <div className="relative mb-6">
        <div className="absolute inset-0 rounded-full bg-primary/15 blur-2xl scale-150" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
          <Shield className="h-9 w-9 text-primary" />
        </div>
      </div>

      <h1 className="text-2xl font-semibold text-foreground text-center">
        {t("onboarding.yourIdentity", "Your identity")}
      </h1>
      <p className="text-sm text-muted-foreground mt-2 text-center max-w-xs">
        {t(
          "onboarding.identityDesc",
          "Cypher uses cryptographic keys instead of accounts.",
        )}
      </p>

      {/* Public key badge */}
      <div className="mt-5 mb-7 inline-flex items-center gap-2.5 rounded-full bg-muted/70 px-4 py-2 ring-1 ring-border">
        <Fingerprint className="h-3.5 w-3.5 text-primary shrink-0" />
        <code className="text-xs text-muted-foreground font-mono tracking-wide">
          {shortKey}
        </code>
      </div>

      {/* Feature cards */}
      <div className="w-full flex flex-col gap-2.5">
        {features.map((f, i) => (
          <div
            key={i}
            className="group flex gap-3.5 rounded-xl bg-muted/40 p-3.5 transition-colors hover:bg-muted/70"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/10 transition-colors group-hover:bg-primary/15">
              <f.icon className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0 pt-0.5">
              <p className="text-[13px] font-medium text-foreground leading-tight">
                {f.title}
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                {f.desc}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex w-full gap-2.5 mt-7">
        <Button variant="outline" onClick={onBack} className="flex-1">
          <ArrowLeft className="h-4 w-4 me-1 rtl:-scale-x-100" />
          {t("common.back", "Back")}
        </Button>
        <Button onClick={onNext} className="flex-1">
          {t("common.continue", "Continue")}
          <ArrowRight className="h-4 w-4 ms-1 rtl:-scale-x-100" />
        </Button>
      </div>
    </div>
  );
}

// ─── Space Step ─────────────────────────────────────────────

function SpaceStep({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [view, setView] = useState<SpaceView>("pick");

  // --- Create ---
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
    },
  });

  function handleCreate(data: z.infer<typeof CreateSchema>) {
    createSpace({ name: data.name });
  }

  // --- Join ---
  const JoinSchema = useMemo(
    () =>
      z.object({
        code: z
          .string()
          .min(1, t("validation.required", "Required"))
          .refine(
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

  const [joinStatus, setJoinStatus] = useState<
    "input" | "connecting" | "done" | "error"
  >("input");
  const [scannerOpen, setScannerOpen] = useState(false);
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

  useEffect(() => {
    return () => {
      setScannerOpen(false);
      cancelPairing();
    };
  }, []);

  function goBackToPick() {
    setView("pick");
    setJoinStatus("input");
    setScannerOpen(false);
    setErrorMsg("");
    joinForm.reset();
    createForm.reset();
  }

  // --- Pick view ---
  const pickContent = (
    <div className="flex flex-col items-center">
      {/* Hero visual */}
      <div className="relative mb-6">
        <div className="absolute inset-0 rounded-full bg-primary/15 blur-2xl scale-150" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
          <Globe className="h-9 w-9 text-primary" />
        </div>
      </div>

      <h1 className="text-2xl font-semibold text-foreground text-center">
        {t("onboarding.getStarted", "Get started")}
      </h1>
      <p className="text-sm text-muted-foreground mt-2 text-center max-w-xs">
        {t(
          "onboarding.spaceDesc",
          "A space is where your pages live. Create your own or join someone else's.",
        )}
      </p>

      {/* Rules */}
      <div className="w-full flex flex-col gap-1.5 mt-5 mb-7">
        <SpaceRule icon={Globe} text={t("onboarding.ruleP2P", "Everything syncs directly between devices — no cloud, no servers.")} />
        <SpaceRule icon={WifiOff} text={t("onboarding.ruleOffline", "Works fully offline. Changes merge automatically when you reconnect.")} />
        <SpaceRule icon={Users} text={t("onboarding.ruleMembers", "Space members can see all pages in the space and edit them.")} />
        <SpaceRule icon={Shield} text={t("onboarding.rulePrivacy", "Your data lives on your devices and syncs over a peer-to-peer connection.")} />
      </div>

      {/* Action cards */}
      <div className="w-full flex flex-col gap-2.5">
        <button
          type="button"
          onClick={() => setView("create")}
          className="group flex items-center gap-3.5 rounded-xl bg-muted/40 p-4 text-start transition-colors hover:bg-muted/70"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/10 transition-colors group-hover:bg-primary/15">
            <Plus className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-foreground">
              {t("space.createNewSpace", "Create new space")}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("onboarding.createDesc", "Start fresh with your own space")}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
        </button>

        <button
          type="button"
          onClick={() => setView("join")}
          className="group flex items-center gap-3.5 rounded-xl bg-muted/40 p-4 text-start transition-colors hover:bg-muted/70"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/10 transition-colors group-hover:bg-primary/15">
            <UserPlus className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-foreground">
              {t("space.joinSpace", "Join space")}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t(
                "onboarding.joinDesc",
                "Use an invite code from someone you trust",
              )}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
        </button>
      </div>

      <Button
        variant="ghost"
        onClick={onBack}
        className="mt-5 text-muted-foreground"
      >
        <ArrowLeft className="h-4 w-4 me-1 rtl:-scale-x-100" />
        {t("common.back", "Back")}
      </Button>
    </div>
  );

  // --- Create view ---
  const createContent = (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 mb-6">
        <button
          type="button"
          onClick={goBackToPick}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />
        </button>
        <h2 className="text-lg font-medium text-foreground">
          {t("space.createNewSpace", "Create new space")}
        </h2>
      </div>

      <p className="text-xs text-muted-foreground mb-5">
        {t("space.createSpaceNote", "You'll be the only member. You can invite others later from space settings.")}
      </p>

      <Form {...createForm}>
        <form
          onSubmit={createForm.handleSubmit(handleCreate)}
          className="flex flex-col gap-4"
        >
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

          <Button type="submit" className="w-full" loading={isCreating}>
            {t("space.createNewSpace", "Create new space")}
          </Button>
        </form>
      </Form>
    </div>
  );

  function handleQrScan(data: string) {
    setScannerOpen(false);
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

  // --- Join view ---
  const joinInputContent = (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 mb-6">
        <button
          type="button"
          onClick={goBackToPick}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />
        </button>
        <h2 className="text-lg font-medium text-foreground">
          {t("space.joinSpace", "Join space")}
        </h2>
      </div>

      <p className="text-xs text-muted-foreground mb-5">
        {t("space.pasteInviteCode", "Paste the invite code you received from a space member.")}
      </p>

      {/* Invite code input */}
      <Form {...joinForm}>
        <form
          onSubmit={joinForm.handleSubmit(handleJoin)}
          className="flex flex-col gap-4"
        >
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
                  className="font-mono text-xs"
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

      {/* Divider with QR option */}
      <div className="flex items-center gap-3 mt-5">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground">{t("common.or", "or")}</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      <button
        type="button"
        onClick={() => setScannerOpen(true)}
        className="mt-4 group flex items-center justify-center gap-2 rounded-lg border border-border py-2.5 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
      >
        <QrCode className="h-4 w-4" />
        {t("scanner.scanQR", "Scan QR")}
      </button>

      <QRScannerDialog
        open={scannerOpen}
        onOpenChange={setScannerOpen}
        onScan={handleQrScan}
      />
    </div>
  );

  function handleCancelJoin() {
    cancelPairing();
    setJoinStatus("input");
    setSpaceName("");
  }

  const joinConnectingContent = (
    <div className="flex flex-col items-center py-10 gap-4">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-primary/15 blur-xl scale-150" />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      </div>
      <div className="text-center mt-1">
        <p className="text-sm font-medium text-foreground">
          {t("space.connecting", "Connecting...")}
        </p>
        <p className="text-xs text-muted-foreground mt-1.5">
          {t("space.waitingForPeer", "Waiting for peer to connect...")}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={handleCancelJoin}
      >
        {t("common.cancel", "Cancel")}
      </Button>
    </div>
  );

  const joinDoneContent = (
    <div className="flex flex-col items-center py-10 gap-4">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-green-500/15 blur-xl scale-150" />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10 ring-1 ring-green-500/20">
          <Check className="h-6 w-6 text-green-600 dark:text-green-400" />
        </div>
      </div>
      <p className="text-sm font-medium text-foreground text-center mt-1">
        {t("space.joinedSpace", 'Joined "{{name}}" successfully!', {
          name: spaceName,
        })}
      </p>
    </div>
  );

  const joinErrorContent = (
    <div className="flex flex-col items-center py-10 gap-4">
      <p className="text-sm text-destructive text-center mt-1">
        {errorMsg || t("common.error", "An error occurred")}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setJoinStatus("input")}
      >
        {t("common.tryAgain", "Try again")}
      </Button>
    </div>
  );

  const joinContent =
    joinStatus === "input"
      ? joinInputContent
      : joinStatus === "connecting"
        ? joinConnectingContent
        : joinStatus === "done"
          ? joinDoneContent
          : joinErrorContent;

  if (view === "pick") return pickContent;
  if (view === "create") return createContent;
  return joinContent;
}

// ─── QR Scanner Dialog/Drawer ────────────────────────────────

function QRScannerDialog({
  open,
  onOpenChange,
  onScan,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScan: (data: string) => void;
}) {
  const { t } = useTranslation();
  const isMobile = useResponsive("(max-width: 768px)");

  const scannerContent = (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-foreground">
          {t("scanner.scanQR", "Scan QR")}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onOpenChange(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {open && (
        <QRScannerView
          onScan={onScan}
          onClose={() => onOpenChange(false)}
          hideClose
        />
      )}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm px-4 pb-6 pt-4">
            {scannerContent}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px] p-5 gap-0">
        {scannerContent}
      </DialogContent>
    </Dialog>
  );
}

// ─── Small helpers ──────────────────────────────────────────

function SpaceRule({
  icon: Icon,
  text,
}: {
  icon: React.ElementType;
  text: string;
}) {
  return (
    <div className="flex items-start gap-2.5 px-1 py-1 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary/60" />
      <span className="leading-relaxed">{text}</span>
    </div>
  );
}
