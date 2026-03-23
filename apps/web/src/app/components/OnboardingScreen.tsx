import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronRight,
  Eye,
  Fingerprint,
  Globe,
  Link2,
  Loader2,
  Lock,
  Plus,
  QrCode,
  Shield,
  UserPlus,
  Users,
  WifiOff,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { updateProfile } from "../api/auth.api";
import { uploadImage, useAssetUrl } from "../api/images.api";
import {
  useCreateSpace,
  useAcceptInvite,
  cancelPairing,
} from "../api/spaces.api";
import { AvatarCropDialog } from "./AvatarCropDialog";
import { useAuth } from "../contexts/AuthContext";
import type { SpaceInvite } from "@/platform/types";
import { QRScannerView } from "./QRScannerView";
import { useMemo } from "react";

type Step = "profile" | "identity" | "space";
type SpaceView = "pick" | "create" | "join";

function decodeInvite(code: string): SpaceInvite | null {
  try {
    const json = atob(code.trim());
    const obj = JSON.parse(json);
    if (obj.topic && obj.secret && obj.spaceId) return obj as SpaceInvite;
    return null;
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
      <div className="w-full max-w-md">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {(["profile", "identity", "space"] as const).map((s) => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                s === step
                  ? "w-6 bg-primary"
                  : (["profile", "identity", "space"].indexOf(s) <
                     ["profile", "identity", "space"].indexOf(step))
                    ? "w-1.5 bg-primary/40"
                    : "w-1.5 bg-border"
              }`}
            />
          ))}
        </div>

        {step === "profile" && (
          <ProfileStep
            onNext={() => setStep("identity")}
          />
        )}
        {step === "identity" && (
          <IdentityStep
            onNext={() => setStep("space")}
            onBack={() => setStep("profile")}
          />
        )}
        {step === "space" && (
          <SpaceStep
            onBack={() => setStep("identity")}
          />
        )}
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
        {t("onboarding.profileDesc", "Set up your profile. This is only visible to people you collaborate with in shared spaces.")}
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
            <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
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
  const shortKey = publicKey.length > 16
    ? `${publicKey.slice(0, 8)}...${publicKey.slice(-8)}`
    : publicKey;

  const features = [
    {
      icon: Fingerprint,
      title: t("onboarding.identityUnique", "Unique to this device"),
      desc: t("onboarding.identityUniqueDesc", "A cryptographic keypair was generated on your device. It identifies you without accounts or passwords."),
    },
    {
      icon: Eye,
      title: t("onboarding.identityVisible", "Visible only in spaces"),
      desc: t("onboarding.identityVisibleDesc", "Your name and avatar are shared only with people in your spaces. Nobody else can see them."),
    },
    {
      icon: Lock,
      title: t("onboarding.identityLocal", "Stays on your device"),
      desc: t("onboarding.identityLocalDesc", "Your private key never leaves this device. There is no server that stores your identity."),
    },
  ];

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold text-foreground text-center">
        {t("onboarding.yourIdentity", "Your identity")}
      </h1>
      <p className="text-sm text-muted-foreground mt-2 text-center">
        {t("onboarding.identityDesc", "Cypher uses cryptographic keys instead of accounts.")}
      </p>

      {/* Public key badge */}
      <div className="flex items-center justify-center mt-6 mb-6">
        <div className="inline-flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
          <Fingerprint className="h-4 w-4 text-primary shrink-0" />
          <code className="text-xs text-muted-foreground font-mono">{shortKey}</code>
        </div>
      </div>

      {/* Feature list */}
      <div className="flex flex-col gap-3">
        {features.map((f, i) => (
          <div key={i} className="flex gap-3 rounded-lg border border-border p-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <f.icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{f.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{f.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 mt-6">
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

    setSpaceName(invite.spaceName);
    setJoinStatus("connecting");

    acceptInvite({
      invite,
      callbacks: {
        onConnected: () => {},
        onComplete: () => {
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

  React.useEffect(() => {
    return () => {
      cancelPairing();
    };
  }, []);

  function goBackToPick() {
    setView("pick");
    setJoinStatus("input");
    setErrorMsg("");
    joinForm.reset();
    createForm.reset();
  }

  // --- Pick view ---
  const pickContent = (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold text-foreground text-center">
        {t("onboarding.getStarted", "Get started")}
      </h1>
      <p className="text-sm text-muted-foreground mt-2 text-center">
        {t("onboarding.spaceDesc", "A space is where your pages live. Create your own or join someone else's.")}
      </p>

      {/* Rules / what happens */}
      <div className="flex flex-col gap-2 mt-6 mb-6">
        <SpaceRule
          icon={Globe}
          text={t("onboarding.ruleP2P", "Everything syncs directly between devices — no cloud, no servers.")}
        />
        <SpaceRule
          icon={WifiOff}
          text={t("onboarding.ruleOffline", "Works fully offline. Changes merge automatically when you reconnect.")}
        />
        <SpaceRule
          icon={Users}
          text={t("onboarding.ruleMembers", "Space members can see all pages in the space and edit them.")}
        />
        <SpaceRule
          icon={Shield}
          text={t("onboarding.rulePrivacy", "Your data lives on your devices and syncs over a peer-to-peer connection.")}
        />
      </div>

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
              {t("onboarding.createDesc", "Start fresh with your own space")}
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
              {t("onboarding.joinDesc", "Use an invite code from someone you trust")}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
        </button>
      </div>

      <Button variant="ghost" onClick={onBack} className="mt-4 text-muted-foreground">
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
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />
        </button>
        <h2 className="text-lg font-medium text-foreground">
          {t("space.createNewSpace", "Create new space")}
        </h2>
      </div>

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
    const invite = decodeInvite(data);
    if (!invite) {
      setJoinStatus("error");
      setErrorMsg(t("space.invalidInviteCode", "Invalid invite code"));
      return;
    }
    setSpaceName(invite.spaceName);
    setJoinStatus("connecting");
    acceptInvite({
      invite,
      callbacks: {
        onConnected: () => {},
        onComplete: () => {
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
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />
        </button>
        <h2 className="text-lg font-medium text-foreground">
          {t("space.joinSpace", "Join space")}
        </h2>
      </div>

      {/* Tab switcher */}
      <div className="flex rounded-lg bg-muted p-1 gap-1 mb-4">
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

  const joinConnectingContent = (
    <div className="flex flex-col items-center py-6 gap-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
      <p className="text-sm font-medium">
        {t("space.connectingToSpace", 'Connecting to "{{name}}"...', {
          name: spaceName,
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("space.waitingForPeer", "Waiting for peer to connect...")}
      </p>
      <Button variant="outline" size="sm" className="mt-1" onClick={handleCancelJoin}>
        {t("common.cancel", "Cancel")}
      </Button>
    </div>
  );

  const joinDoneContent = (
    <div className="flex flex-col items-center py-6 gap-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
        <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
      </div>
      <p className="text-sm font-medium text-center">
        {t("space.joinedSpace", 'Joined "{{name}}" successfully!', {
          name: spaceName,
        })}
      </p>
    </div>
  );

  const joinErrorContent = (
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

// ─── Small helpers ──────────────────────────────────────────

function SpaceRule({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="flex items-start gap-2.5 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary/60" />
      <span>{text}</span>
    </div>
  );
}
