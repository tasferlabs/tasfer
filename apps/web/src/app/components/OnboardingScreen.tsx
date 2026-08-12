/* OnboardingScreen.tsx — Tasfer first-run flow.
 *   1. identity  — the keypair Tasfer already generated; on-device by default
 *   2. profile   — optional name + avatar (collapsed), only matters for sharing
 *   3. space     — create your own (optional name) OR join a peer's
 *                  (paste code / import invite file / scan QR)
 *
 * The steps are shell-agnostic: desktop presents them in a modal dialog over the
 * app shell, mobile keeps them as a full-screen page (see the shells at the
 * bottom of this file). Layout decides which one it mounts.
 *
 * UI ported from the Claude Design handoff bundle (see OnboardingScreen.css).
 * Every step is wired to the real platform APIs.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Fingerprint,
  ImagePlus,
  Loader2,
  Lock,
  MonitorSmartphone,
  Plus,
  QrCode,
  Share2,
  ShieldCheck,
  Upload,
  User,
  Users,
  X,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { updateProfile } from "../api/auth.api";
import { uploadImage, useAssetUrl } from "../api/images.api";
import {
  cancelPairing,
  useAcceptDeviceLink,
  useAcceptInvite,
  useCreateSpace,
} from "../api/spaces.api";
import { useAuth } from "../contexts/AuthContext";
import useMobileLayout from "../hooks/useMobileLayout";
import { decodeInvite, isDeviceLink, isInviteExpired } from "../inviteCode";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getPlatform } from "@/platform";
import type { SpaceInvite } from "@/platform/types";
import { AvatarCropDialog } from "./AvatarCropDialog";
import "./OnboardingScreen.css";
import { QRScannerView } from "./QRScannerView";

const STEPS = ["identity", "profile", "space"] as const;
type Step = (typeof STEPS)[number];

/** Current step, read by the card head so steps don't have to thread it down. */
const StepContext = React.createContext<Step>(STEPS[0]);

/**
 * Leaving onboarding requires at least one space, so skipping the flow creates
 * the default personal space and drops the user straight into the app.
 */
function useSkipSetup() {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const { mutate, isPending } = useCreateSpace({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },
    onError: (err) => setError(err.message),
  });

  function skip() {
    setError("");
    mutate({ name: "" });
  }

  return { skip, isPending, error };
}

/**
 * Leaving onboarding is decided by the spaces query, and spaces can arrive
 * without this flow asking for them: a device link writes them straight to the
 * database when the enrolment payload lands, which is after pairing reports
 * "linked". The app's listener for that lives in the sidebar — the very thing
 * onboarding stands in for — so without this the flow never hears about them.
 */
function useSpacesArrive() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let platform: ReturnType<typeof getPlatform>;
    try {
      platform = getPlatform();
    } catch {
      return;
    }
    return platform.spaces.onChange(() => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
      // A link can hand over spaces the person had archived, which is a
      // different exit from onboarding but an exit all the same.
      queryClient.invalidateQueries({ queryKey: ["spaces-archived"] });
    });
  }, [queryClient]);
}

/* ── card head: progress + escape hatch ────────────────────────────────── */
function CardHead() {
  const { t } = useTranslation();
  const step = React.useContext(StepContext);
  const { skip, isPending, error } = useSkipSetup();
  const idx = STEPS.indexOf(step);

  return (
    <>
      <div className="ob-head">
        <div
          className="ob-dots"
          role="group"
          aria-label={t(
            "onboarding.stepProgress",
            "Step {{current}} of {{total}}",
            { current: idx + 1, total: STEPS.length },
          )}
        >
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`ob-dot${
                s === step ? " ob-dot-active" : i < idx ? " ob-dot-done" : ""
              }`}
            />
          ))}
        </div>
        <button className="ob-skip" onClick={skip} disabled={isPending}>
          {isPending && (
            <Loader2 size={13} strokeWidth={2} className="ob-spin-icon" />
          )}
          {t("onboarding.skipSetup", "Skip setup")}
        </button>
      </div>
      {error && (
        <p className="ob-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/* ── 1. identity ───────────────────────────────────────────────────────── */
/**
 * Linking an existing device belongs here rather than beside "join a space" on
 * step 3: it answers "is this a new you?", not "which space do you want?". The
 * two never appear side by side, so neither reads as a flavour of the other.
 */
function IdentityStep({
  onNext,
  onLink,
}: {
  onNext: () => void;
  onLink: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="ob-card">
      <CardHead />
      <div className="ob-icon-wrap">
        <Fingerprint size={22} strokeWidth={1.5} />
      </div>
      <h2 className="ob-title">
        {t("onboarding.identityTitle", "An identity was created for you.")}
      </h2>
      <p className="ob-sub">
        {t(
          "onboarding.identityIntro",
          "The moment you opened Tasfer, it generated a keypair on this device — that's your identity. The private key never leaves this machine, and there's no account or server behind it.",
        )}
      </p>

      <ul className="ob-bullets">
        <li>
          <ShieldCheck size={15} strokeWidth={1.5} />
          {t(
            "onboarding.bulletOnDevice",
            "Everything stays on this device — until you choose to share.",
          )}
        </li>
        <li>
          <Check size={14} strokeWidth={1.5} />
          {t("onboarding.bulletNoAccount", "No account, no cloud, no sign-up.")}
        </li>
        <li>
          <Check size={14} strokeWidth={1.5} />
          {t(
            "onboarding.bulletRecovery",
            "Export a recovery file anytime to back it up.",
          )}
        </li>
      </ul>

      <div className="ob-actions ob-actions-split">
        <span className="ob-alt">
          {t("onboarding.alreadyHaveTasfer", "Already using Tasfer?")}{" "}
          <button className="ob-alt-link" onClick={onLink}>
            {t("onboarding.bringThisDeviceIn", "Link this device")}
          </button>
        </span>
        <button className="ob-btn ob-btn-primary" onClick={onNext}>
          {t("common.continue", "Continue")}
        </button>
      </div>
    </div>
  );
}

/* ── 1b. link an existing device (branch off identity) ─────────────────── */
function LinkExistingStep({
  initialCode,
  onBack,
  onSpaceInvite,
  onSetUpSpace,
}: {
  initialCode: string;
  onBack: () => void;
  /** The pasted code turned out to be a space invite — hand it to step 3. */
  onSpaceInvite: (code: string) => void;
  /** Way out of a link that connected but never delivered anything. */
  onSetUpSpace: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<"scan" | "code">(
    initialCode ? "code" : "scan",
  );
  const [code, setCode] = useState(initialCode);
  const [camera, setCamera] = useState(false);
  const [status, setStatus] = useState<JoinStatus>("input");
  const [errorMsg, setErrorMsg] = useState("");
  /** Set when the failure is "wrong kind of code", which has a way out. */
  const [wrongKind, setWrongKind] = useState("");
  const activeInviteRef = useRef<SpaceInvite | null>(null);

  const { mutate: acceptDeviceLink } = useAcceptDeviceLink();

  function runLink(raw: string) {
    const invite = decodeInvite(raw);
    if (!invite) {
      setWrongKind("");
      setStatus("error");
      setErrorMsg(t("space.invalidInviteCode", "Invalid invite code"));
      return;
    }
    if (!isDeviceLink(invite)) {
      setWrongKind(raw.trim());
      setStatus("error");
      setErrorMsg(
        t(
          "onboarding.notADeviceCode",
          "That's an invite to a space, not a device code. It adds you to one space instead of bringing your whole setup here.",
        ),
      );
      return;
    }
    if (isInviteExpired(invite)) {
      setWrongKind("");
      setStatus("error");
      setErrorMsg(
        t("device.codeExpired", "This code has expired. Generate a new one."),
      );
      return;
    }
    setWrongKind("");
    setStatus("connecting");
    activeInviteRef.current = invite;
    acceptDeviceLink({
      invite,
      callbacks: {
        onComplete: () => {
          activeInviteRef.current = null;
          setStatus("done");
          // Every space arrives at once, which is also what ends onboarding.
          queryClient.invalidateQueries({ queryKey: ["spaces"] });
          queryClient.invalidateQueries({ queryKey: ["pages"] });
        },
        onError: (msg) => {
          setStatus("error");
          setErrorMsg(msg);
        },
      },
    });
  }

  function cancelActiveLink() {
    const invite = activeInviteRef.current;
    if (invite) {
      activeInviteRef.current = null;
      cancelPairing(invite);
    }
  }

  useEffect(() => {
    return () => {
      cancelActiveLink();
    };
  }, []);

  function handleScan(data: string) {
    setCamera(false);
    setCode(data.trim());
    runLink(data);
  }

  if (status === "connecting") {
    return (
      <div className="ob-card">
        <div className="ob-status">
          <div className="ob-status-ico spin">
            <Loader2 size={24} strokeWidth={2} />
          </div>
          <div className="ob-status-title">
            {t("space.connecting", "Connecting…")}
          </div>
          <div className="ob-status-sub">
            {t("device.keepBothOpen", "Keep both devices open.")}
          </div>
          <button
            className="ob-btn ob-btn-outline"
            onClick={() => {
              cancelActiveLink();
              setStatus("input");
              setErrorMsg("");
            }}
          >
            {t("common.cancel", "Cancel")}
          </button>
        </div>
      </div>
    );
  }

  if (status === "done") {
    return <LinkedCard onSetUpSpace={onSetUpSpace} />;
  }

  if (status === "error") {
    return (
      <div className="ob-card">
        <div className="ob-status">
          <div className="ob-status-error">
            {errorMsg || t("common.error", "An error occurred")}
          </div>
          {wrongKind && (
            <button
              className="ob-btn ob-btn-primary"
              onClick={() => onSpaceInvite(wrongKind)}
            >
              {t("onboarding.useAsSpaceInvite", "Join that space instead")}
            </button>
          )}
          <button
            className="ob-btn ob-btn-outline"
            onClick={() => {
              setWrongKind("");
              setStatus("input");
            }}
          >
            {t("common.tryAgain", "Try again")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ob-card">
      <CardHead />
      <div className="ob-icon-wrap">
        <MonitorSmartphone size={22} strokeWidth={1.5} />
      </div>
      <h2 className="ob-title">
        {t("onboarding.linkTitle", "Bring this device in.")}
      </h2>
      <p className="ob-sub">
        {t(
          "onboarding.linkIntro",
          "Your other device can hand this one the same identity, and every space you have appears here. Open Profile → Link a device there to get the code.",
        )}
      </p>

      <div className="ob-seg" role="tablist">
        <button
          role="tab"
          aria-current={method === "scan"}
          onClick={() => setMethod("scan")}
        >
          <QrCode size={16} strokeWidth={1.5} />
          {t("scanner.scanQR", "Scan QR")}
        </button>
        <button
          role="tab"
          aria-current={method === "code"}
          onClick={() => setMethod("code")}
        >
          <Copy size={16} strokeWidth={1.5} />
          {t("onboarding.pasteCode", "Paste code")}
        </button>
      </div>

      {/* No decorative scan frame here: "Open camera" below already is the
          action, and the card has to clear the fold on a phone. */}
      {method === "scan" ? (
        <p className="ob-hint">
          {t(
            "onboarding.linkScanHint",
            "Point your camera at the code your other device is showing.",
          )}
        </p>
      ) : (
        <>
          <label className="ob-label">
            {t("onboarding.deviceCode", "Device code")}
          </label>
          <textarea
            className="ob-input ob-textarea ob-mono"
            placeholder={t("device.codePlaceholder", "Paste the device code")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </>
      )}

      <div className="ob-actions">
        <button className="ob-btn ob-btn-ghost" onClick={onBack}>
          {t("common.back", "Back")}
        </button>
        {method === "scan" ? (
          <button
            className="ob-btn ob-btn-primary"
            onClick={() => setCamera(true)}
          >
            <Camera size={15} strokeWidth={1.5} />{" "}
            {t("onboarding.openCamera", "Open camera")}
          </button>
        ) : (
          <button
            className="ob-btn ob-btn-primary"
            disabled={!code.trim()}
            onClick={() => runLink(code)}
          >
            {t("device.link", "Link device")}
          </button>
        )}
      </div>

      {camera && (
        <CameraDrawer
          onScan={handleScan}
          onClose={() => setCamera(false)}
          title={t("onboarding.scanDeviceQR", "Scan device code")}
          hint={t(
            "onboarding.linkScanDrawerHint",
            "Hold your other device's code inside the frame. It links the moment it reads.",
          )}
        />
      )}
    </div>
  );
}

/**
 * End of the link flow. Nothing to press: pairing is done, and onboarding ends
 * by itself the moment the enrolment payload lands and this device owns a
 * space. That payload arrives a beat after "linked" and can also fail to arrive
 * at all — so the card says what it is waiting for, and grows a way out rather
 * than waiting forever.
 */
function LinkedCard({ onSetUpSpace }: { onSetUpSpace: () => void }) {
  const { t } = useTranslation();
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setStalled(true), 15_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="ob-card">
      <div className="ob-status">
        <div className="ob-status-ico">
          <Check size={24} strokeWidth={2} />
        </div>
        <div className="ob-status-title">{t("device.doneTitle", "Linked")}</div>
        <div className="ob-status-sub">
          {t(
            "onboarding.linkedSyncingHere",
            "Your spaces are on their way to this device.",
          )}
        </div>
        {stalled && (
          <>
            <div className="ob-status-sub">
              {t(
                "onboarding.linkedNothingYet",
                "Nothing has arrived yet. Keep your other device open and awake — or start a space here and carry on.",
              )}
            </div>
            <button className="ob-btn ob-btn-outline" onClick={onSetUpSpace}>
              {t("onboarding.setUpSpaceInstead", "Set up a space instead")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── 2. profile (optional, collapsed) ──────────────────────────────────── */
function ProfileStep({
  name,
  setName,
  avatarId,
  setAvatarId,
  onNext,
  onBack,
}: {
  name: string;
  setName: (v: string) => void;
  avatarId: string | null;
  setAvatarId: (v: string | null) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { updateUser } = useAuth();
  const [open, setOpen] = useState(Boolean(name || avatarId));
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarUrl = useAssetUrl(avatarId);

  const initial = (name.trim()[0] || "").toUpperCase();
  const hasContent = Boolean(name.trim() || avatarId);

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
    // Optional step — only persist when the user actually entered something.
    if (hasContent) {
      try {
        setSaving(true);
        const updated = await updateProfile({
          name: name.trim(),
          avatar: avatarId,
        });
        updateUser(updated);
      } catch (err) {
        console.error("Failed to save profile:", err);
      } finally {
        setSaving(false);
      }
    }
    onNext();
  }

  return (
    <div className="ob-card">
      <CardHead />
      <div className="ob-icon-wrap">
        <Share2 size={22} strokeWidth={1.5} />
      </div>
      <h2 className="ob-title">
        {t("onboarding.profileTitle", "A face for sharing — if you want one.")}
      </h2>
      <p className="ob-sub">
        {t(
          "onboarding.profileIntro",
          "Tasfer works fully anonymous. The only time a name or avatar matters is when you invite someone to a space — it's how they'll tell your edits apart. You can add this now or never.",
        )}
      </p>

      <div className="ob-collapse">
        <button className="ob-collapse-head" onClick={() => setOpen((o) => !o)}>
          <User size={18} strokeWidth={1.5} />
          <div>
            <div className="ob-collapse-title">
              {t("onboarding.addNameAvatar", "Add a name & avatar")}
            </div>
            <div className="ob-collapse-sub">
              {name.trim()
                ? name.trim()
                : t(
                    "onboarding.optionalForShared",
                    "Optional · for shared spaces",
                  )}
            </div>
          </div>
          <ChevronDown
            size={18}
            strokeWidth={1.5}
            className={`ob-chev${open ? " open" : ""}`}
          />
        </button>
        {open && (
          <div className="ob-collapse-body">
            <div className="ob-avatar-row">
              <div
                className={`ob-avatar${avatarUrl || initial ? "" : " empty"}`}
              >
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" />
                ) : initial ? (
                  initial
                ) : (
                  <ImagePlus size={20} strokeWidth={1.5} />
                )}
              </div>
              <div className="ob-avatar-actions">
                <button
                  className="ob-avatar-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  <ImagePlus size={14} strokeWidth={1.5} />
                  {avatarId
                    ? t("onboarding.replacePhoto", "Replace photo")
                    : t("onboarding.addPhoto", "Add photo")}
                </button>
                <span className="ob-avatar-hint">
                  {t("onboarding.pngOrJpg", "PNG or JPG")}
                </span>
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
            <label className="ob-label">
              {t("profile.displayName", "Display name")}
            </label>
            <input
              className="ob-input"
              placeholder={t("onboarding.anonymous", "anonymous")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="ob-actions">
        <button className="ob-btn ob-btn-ghost" onClick={onBack}>
          {t("common.back", "Back")}
        </button>
        <button
          className="ob-btn ob-btn-primary"
          onClick={handleNext}
          disabled={saving || uploading}
        >
          {/* Always "Continue": the step is optional either way, and "Skip"
              here would collide with "Skip setup" in the head, which leaves the
              whole flow. */}
          {t("common.continue", "Continue")}
        </button>
      </div>

      <AvatarCropDialog
        file={pendingFile}
        onCropped={handleCropped}
        onCancel={() => setPendingFile(null)}
      />
    </div>
  );
}

/* ── 3a. space — pick ──────────────────────────────────────────────────── */
function SpacePick({
  setView,
  onBack,
}: {
  setView: (v: SpaceView) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="ob-card">
      <CardHead />
      <div className="ob-icon-wrap">
        <Box size={22} strokeWidth={1.5} />
      </div>
      <h2 className="ob-title">
        {t("onboarding.spaceTitle", "Set up your first space.")}
      </h2>
      <p className="ob-sub">
        {t(
          "onboarding.spaceIntro",
          "A space is a workspace that syncs directly between you and the people you invite — peer to peer, no server in the middle. Start one of your own, or join a peer's.",
        )}
      </p>

      <button className="ob-row" onClick={() => setView("create")}>
        <Plus size={18} strokeWidth={1.5} />
        <div>
          <div className="ob-row-title">
            {t("space.createNewSpace", "Create a new space")}
          </div>
          <div className="ob-row-sub">
            {t(
              "onboarding.createSpaceSub",
              "Just for you. Invite others whenever you like.",
            )}
          </div>
        </div>
        <ChevronRight size={16} strokeWidth={1.5} />
      </button>

      <button className="ob-row" onClick={() => setView("join")}>
        <Users size={18} strokeWidth={1.5} />
        <div>
          <div className="ob-row-title">
            {t("onboarding.joinSomeonesSpace", "Join someone's space")}
          </div>
          <div className="ob-row-sub">
            {t(
              "onboarding.joinSpaceSub",
              "Paste a code, import an invite, or scan a QR.",
            )}
          </div>
        </div>
        <ChevronRight size={16} strokeWidth={1.5} />
      </button>

      {/* The two rows above are the choices here; "Skip setup" in the head is
          the way out, so this row carries no primary of its own. */}
      <div className="ob-actions">
        <button className="ob-btn ob-btn-ghost" onClick={onBack}>
          {t("common.back", "Back")}
        </button>
      </div>
    </div>
  );
}

/* ── 3b. space — create ────────────────────────────────────────────────── */
function SpaceCreate({ setView }: { setView: (v: SpaceView) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [org, setOrg] = useState("");
  const [createError, setCreateError] = useState("");

  const { mutate: createSpace, isPending: isCreating } = useCreateSpace({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },
    onError: (err) => setCreateError(err.message),
  });

  function handleCreate() {
    // Space name is optional in the flow; fall back to a sensible default.
    setCreateError("");
    createSpace({ name: org.trim() || "" });
  }

  return (
    <div className="ob-card">
      <CardHead />
      <div className="ob-icon-wrap">
        <Plus size={22} strokeWidth={1.5} />
      </div>
      <h2 className="ob-title">
        {t("onboarding.createSpaceTitle", "Create your space.")}
      </h2>
      <p className="ob-sub">
        {t(
          "onboarding.createSpaceIntro",
          "It lives only on this device until you invite someone. Give it a name to keep things organized — or leave it blank and it's simply yours.",
        )}
      </p>

      <label className="ob-label">
        {t("onboarding.spaceNameOptional", "Space name (optional)")}
      </label>
      <input
        className="ob-input"
        placeholder={t("common.personal", "Personal")}
        value={org}
        onChange={(e) => setOrg(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isCreating) handleCreate();
        }}
        autoFocus
      />

      <div className="ob-note">
        <Lock size={14} strokeWidth={1.5} />
        <span>
          {t(
            "onboarding.createSpaceNote",
            "Nothing leaves your device until you generate an invite from inside the space.",
          )}
        </span>
      </div>

      {createError && (
        <p className="ob-error" role="alert">
          {createError}
        </p>
      )}

      <div className="ob-actions">
        <button
          className="ob-btn ob-btn-ghost"
          onClick={() => setView("pick")}
          disabled={isCreating}
        >
          {t("common.back", "Back")}
        </button>
        <button
          className="ob-btn ob-btn-primary"
          onClick={handleCreate}
          disabled={isCreating}
        >
          {isCreating && (
            <Loader2 size={15} strokeWidth={2} className="ob-spin-icon" />
          )}
          {t("space.createNewSpace", "Create space")}
        </button>
      </div>
    </div>
  );
}

/* ── 3c. space — join ──────────────────────────────────────────────────── */
type JoinMethod = "code" | "file" | "scan";
type JoinStatus = "input" | "connecting" | "done" | "error";

function SpaceJoin({
  setView,
  initialCode,
  onDeviceLink,
}: {
  setView: (v: SpaceView) => void;
  initialCode: string;
  /** The code turned out to link a device, not join a space. */
  onDeviceLink: (code: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<JoinMethod>("code");
  const [code, setCode] = useState(initialCode);
  const [fileName, setFileName] = useState("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [status, setStatus] = useState<JoinStatus>("input");
  const [camera, setCamera] = useState(false);
  const [spaceName, setSpaceName] = useState("");
  const [wasRestored, setWasRestored] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  /** Set when the failure is "wrong kind of code", which has a way out. */
  const [wrongKind, setWrongKind] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Invite currently being accepted — cancel target */
  const activeInviteRef = useRef<SpaceInvite | null>(null);

  const { mutate: acceptInvite } = useAcceptInvite({
    onSuccess: (result) => {
      // Space already here, archived: restored outright, so no pairing runs
      // and no callback below will fire.
      if (result.status !== "restored") return;
      activeInviteRef.current = null;
      setSpaceName(result.spaceName);
      setWasRestored(true);
      setStatus("done");
    },
    // The accept can reject before pairing starts, and `callbacks.onError` only
    // covers failures the replicator reports — without this the screen sits on
    // the connecting spinner for good.
    onError: (err) => {
      activeInviteRef.current = null;
      setStatus("error");
      setErrorMsg(err.message);
    },
  });

  const canJoin =
    (method === "code" && code.trim().length > 0) ||
    (method === "file" && Boolean(fileName));

  function runJoin(raw: string) {
    const invite = decodeInvite(raw);
    if (!invite) {
      setWrongKind("");
      setStatus("error");
      setErrorMsg(t("space.invalidInviteCode", "Invalid invite code"));
      return;
    }
    // Device codes decode cleanly here and would only fail deep in pairing, so
    // name the mistake and offer the flow that wants it.
    if (isDeviceLink(invite)) {
      setWrongKind(raw.trim());
      setStatus("error");
      setErrorMsg(
        t(
          "onboarding.notASpaceInvite",
          "That's a device code, not a space invite. It brings your whole setup from another device onto this one.",
        ),
      );
      return;
    }
    setWrongKind("");
    if (isInviteExpired(invite)) {
      setStatus("error");
      setErrorMsg(
        t("space.inviteExpired", "This invite has expired. Ask for a new one."),
      );
      return;
    }
    setStatus("connecting");
    setWasRestored(false);
    activeInviteRef.current = invite;
    acceptInvite({
      invite,
      callbacks: {
        onConnected: () => {},
        onComplete: (_peer, name) => {
          if (name) setSpaceName(name);
          setStatus("done");
          queryClient.invalidateQueries({ queryKey: ["spaces"] });
          queryClient.invalidateQueries({ queryKey: ["pages"] });
        },
        onError: (msg) => {
          setStatus("error");
          setErrorMsg(msg);
        },
      },
    });
  }

  async function handleFile(file: File) {
    setIsDraggingFile(false);
    setFileName(file.name);
    try {
      const text = await file.text();
      setCode(text.trim());
      runJoin(text);
    } catch {
      setStatus("error");
      setErrorMsg(t("import.failed", "Import failed"));
    }
  }

  function handleFileDrag(event: React.DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingFile(true);
  }

  function handleFileDragLeave(event: React.DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setIsDraggingFile(false);
  }

  function handleFileDrop(event: React.DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDraggingFile(false);
    const file = event.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  function handleScan(data: string) {
    setCamera(false);
    runJoin(data);
  }

  function cancelActiveJoin() {
    const invite = activeInviteRef.current;
    if (invite) {
      activeInviteRef.current = null;
      cancelPairing(invite);
    }
  }

  function handleCancel() {
    cancelActiveJoin();
    setStatus("input");
    setSpaceName("");
    setErrorMsg("");
  }

  useEffect(() => {
    return () => {
      cancelActiveJoin();
    };
  }, []);

  if (status === "connecting") {
    return (
      <div className="ob-card">
        <div className="ob-status">
          <div className="ob-status-ico spin">
            <Loader2 size={24} strokeWidth={2} />
          </div>
          <div className="ob-status-title">
            {t("space.connecting", "Connecting…")}
          </div>
          <div className="ob-status-sub">
            {t("space.waitingForPeer", "Waiting for peer to connect…")}
          </div>
          <button className="ob-btn ob-btn-outline" onClick={handleCancel}>
            {t("common.cancel", "Cancel")}
          </button>
        </div>
      </div>
    );
  }

  if (status === "done") {
    return (
      <div className="ob-card">
        <div className="ob-status">
          <div className="ob-status-ico">
            <Check size={24} strokeWidth={2} />
          </div>
          <div className="ob-status-title">
            {!spaceName
              ? t("space.peerConnected", "Connected!")
              : wasRestored
                ? t(
                    "space.restoredSpace",
                    'Restored "{{name}}" — you had this space archived.',
                    { name: spaceName },
                  )
                : t("space.joinedSpace", 'Joined "{{name}}" successfully!', {
                    name: spaceName,
                  })}
          </div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="ob-card">
        <div className="ob-status">
          <div className="ob-status-error">
            {errorMsg || t("common.error", "An error occurred")}
          </div>
          {wrongKind && (
            <button
              className="ob-btn ob-btn-primary"
              onClick={() => onDeviceLink(wrongKind)}
            >
              {t("onboarding.useAsDeviceCode", "Link this device instead")}
            </button>
          )}
          <button
            className="ob-btn ob-btn-outline"
            onClick={() => {
              setWrongKind("");
              setStatus("input");
            }}
          >
            {t("common.tryAgain", "Try again")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ob-card">
      <CardHead />
      <div className="ob-icon-wrap">
        <Users size={22} strokeWidth={1.5} />
      </div>
      <h2 className="ob-title">{t("onboarding.joinTitle", "Join a space.")}</h2>
      <p className="ob-sub">
        {t(
          "onboarding.joinIntro",
          "Use an invite from a peer. It hands your device the keys to sync directly with theirs.",
        )}
      </p>

      <div className="ob-seg" role="tablist">
        <button
          role="tab"
          aria-current={method === "code"}
          onClick={() => setMethod("code")}
        >
          <Copy size={16} strokeWidth={1.5} />
          {t("onboarding.pasteCode", "Paste code")}
        </button>
        <button
          role="tab"
          aria-current={method === "file"}
          onClick={() => setMethod("file")}
        >
          <Upload size={16} strokeWidth={1.5} />
          {t("onboarding.importFile", "Import file")}
        </button>
        <button
          role="tab"
          aria-current={method === "scan"}
          onClick={() => setMethod("scan")}
        >
          <QrCode size={16} strokeWidth={1.5} />
          {t("scanner.scanQR", "Scan QR")}
        </button>
      </div>

      {method === "code" && (
        <>
          <label className="ob-label">
            {t("space.inviteCode", "Invite code")}
          </label>
          <textarea
            className="ob-input ob-textarea ob-mono"
            placeholder={t(
              "onboarding.pasteCodePlaceholder",
              "paste the base64 invite your peer sent you…",
            )}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </>
      )}

      {method === "file" && (
        <>
          <button
            data-file-drop-scope="local"
            className={`ob-import${fileName ? " has-file" : ""}${
              isDraggingFile ? " is-dragging" : ""
            }`}
            onDragEnter={handleFileDrag}
            onDragOver={handleFileDrag}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
            onClick={() => {
              if (fileName) {
                setFileName("");
                setCode("");
              } else {
                fileInputRef.current?.click();
              }
            }}
          >
            <Upload size={22} strokeWidth={1.5} />
            <span className="ob-import-title">
              {isDraggingFile
                ? t("import.dropFile", "Drop file here")
                : fileName ||
                  t("onboarding.chooseInviteFile", "Choose an invite file")}
            </span>
            <span className="ob-import-sub">
              {fileName
                ? t("onboarding.tapToRemove", "Tap to remove")
                : t(
                    "onboarding.tasferInviteHint",
                    "A .tasferinvite file from your peer",
                  )}
            </span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".tasferinvite,text/plain,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
            hidden
          />
        </>
      )}

      {method === "scan" && (
        <div className="ob-scan">
          <button
            className="ob-scan-frame"
            onClick={() => setCamera(true)}
            aria-label={t("scanner.scanQR", "Scan QR")}
          >
            <QrCode size={40} strokeWidth={1.5} />
          </button>
          <p className="ob-scan-text">
            {t(
              "onboarding.scanHint",
              "Point your camera at the QR code shown on your peer's device.",
            )}
          </p>
        </div>
      )}

      <div className="ob-actions">
        <button className="ob-btn ob-btn-ghost" onClick={() => setView("pick")}>
          {t("common.back", "Back")}
        </button>
        {method === "scan" ? (
          <button
            className="ob-btn ob-btn-primary"
            onClick={() => setCamera(true)}
          >
            <Camera size={15} strokeWidth={1.5} />{" "}
            {t("onboarding.openCamera", "Open camera")}
          </button>
        ) : (
          <button
            className="ob-btn ob-btn-primary"
            disabled={!canJoin}
            onClick={() => runJoin(code)}
          >
            {t("space.joinSpace", "Join space")}
          </button>
        )}
      </div>

      {camera && (
        <CameraDrawer onScan={handleScan} onClose={() => setCamera(false)} />
      )}
    </div>
  );
}

/* ── camera (bottom sheet on mobile, nested dialog on desktop) ─────────── */
function CameraDrawer({
  onScan,
  onClose,
  title,
  hint,
}: {
  onScan: (data: string) => void;
  onClose: () => void;
  title?: string;
  hint?: string;
}) {
  const { t } = useTranslation();
  const { isMobile } = useMobileLayout();

  const heading = title ?? t("onboarding.scanInviteQR", "Scan invite QR");
  const head = (
    <div className="ob-drawer-head">
      {isMobile ? <h3>{heading}</h3> : <DialogTitle>{heading}</DialogTitle>}
      <button
        className="ob-icon-btn"
        onClick={onClose}
        aria-label={t("common.close", "Close")}
      >
        <X size={18} strokeWidth={1.5} />
      </button>
    </div>
  );

  const body = (
    <>
      <p className="ob-drawer-sub">
        {hint ??
          t(
            "onboarding.scanDrawerHint",
            "Hold your peer's QR code inside the frame. It connects the moment it reads.",
          )}
      </p>
      <QRScannerView onScan={onScan} onClose={onClose} hideClose />
      <div className="ob-drawer-foot">
        <button className="ob-btn ob-btn-outline" onClick={onClose}>
          {t("common.close", "Close")}
        </button>
      </div>
    </>
  );

  // The desktop shell is a transformed dialog, which would make a `position:
  // fixed` scrim resolve against the card instead of the viewport — so the
  // scanner gets its own dialog layer there.
  if (!isMobile) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent className="ob-cam-dialog">
          {head}
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div className="ob-scrim" onClick={onClose}>
      <div className="ob-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ob-drawer-grip" />
        {head}
        {body}
      </div>
    </div>
  );
}

/* ── space router ──────────────────────────────────────────────────────── */
type SpaceView = "pick" | "create" | "join";

function SpaceStep({
  onBack,
  initialCode,
  onDeviceLink,
}: {
  onBack: () => void;
  initialCode: string;
  onDeviceLink: (code: string) => void;
}) {
  // A code handed over from the link flow lands straight in the join view.
  const [view, setView] = useState<SpaceView>(initialCode ? "join" : "pick");
  if (view === "create") return <SpaceCreate setView={setView} />;
  if (view === "join")
    return (
      <SpaceJoin
        setView={setView}
        initialCode={initialCode}
        onDeviceLink={onDeviceLink}
      />
    );
  return <SpacePick setView={setView} onBack={onBack} />;
}

/* ── shell: full-screen page (mobile) ──────────────────────────────────── */
function OnboardingPage({ children }: { children: React.ReactNode }) {
  // Soft-keyboard handling. `.ob-wrap` is a height:100dvh scroll container, but
  // `dvh` does NOT shrink when the on-screen keyboard opens — so a field near
  // the bottom sits behind the keyboard with no room to scroll to it. Shrink the
  // container to the area above the keyboard so the card overflows, then scroll
  // the focused field into the now-visible area.
  //
  // The keyboard inset comes from two sources, per platform:
  //   • Android: the WebView is edge-to-edge, so `resize:"native"` is a no-op
  //     and `visualViewport` does NOT shrink for the IME. MainActivity posts the
  //     real inset as a `keyboard-height-changed` message (same signal the editor
  //     host consumes). Once it reports, it wins.
  //   • iOS / mobile web: `visualViewport` shrinks for the keyboard; bind to it.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const vv = window.visualViewport;

    let focused: HTMLElement | null = null;
    // Native IME inset (CSS px) once a platform source reports it; until then we
    // fall back to visualViewport, matching the editor host's precedence.
    let nativeKeyboard = 0;
    let nativeReported = false;

    const reveal = () =>
      focused?.scrollIntoView({ block: "center", behavior: "smooth" });

    // iOS Safari reveals a focused field by scrolling the layout viewport —
    // bypassing the app shell's html/body overflow:hidden — which drags the
    // pinned shell (and this card) off the top of the screen and never brings
    // it back. The document is never legitimately scrolled (every route
    // scrolls internally), so any window scroll is that pan: undo it and let
    // the shrunken wrap scroll the field into view instead.
    const pinViewport = () => {
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      reveal();
    };

    const syncHeight = () => {
      if (nativeReported) {
        wrap.style.height = `calc(100dvh - ${nativeKeyboard}px)`;
      } else if (vv) {
        wrap.style.height = `${vv.height}px`;
      }
      pinViewport();
    };

    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        focused = el;
        // Wait for the keyboard/viewport to settle before scrolling.
        window.setTimeout(pinViewport, 350);
      }
    };
    const onFocusOut = () => {
      focused = null;
    };

    // Android IME inset posted by MainActivity: { type, height (dp ≈ CSS px),
    // isOpen }. Validated inline to keep onboarding self-contained.
    const onNativeKeyboard = (e: MessageEvent) => {
      const data = e.data as {
        type?: unknown;
        height?: unknown;
        isOpen?: unknown;
      } | null;
      if (
        e.source !== window ||
        !data ||
        data.type !== "keyboard-height-changed" ||
        typeof data.height !== "number" ||
        !Number.isFinite(data.height) ||
        typeof data.isOpen !== "boolean"
      ) {
        return;
      }
      nativeReported = true;
      nativeKeyboard = data.isOpen ? Math.max(0, data.height) : 0;
      syncHeight();
    };

    syncHeight();
    vv?.addEventListener("resize", syncHeight);
    vv?.addEventListener("scroll", pinViewport);
    // Safari's focus pan lands on the layout viewport, which fires `scroll`
    // on window (not on visualViewport) — catch and undo it there.
    window.addEventListener("scroll", pinViewport);
    wrap.addEventListener("focusin", onFocusIn);
    wrap.addEventListener("focusout", onFocusOut);
    window.addEventListener("message", onNativeKeyboard);
    return () => {
      vv?.removeEventListener("resize", syncHeight);
      vv?.removeEventListener("scroll", pinViewport);
      window.removeEventListener("scroll", pinViewport);
      wrap.removeEventListener("focusin", onFocusIn);
      wrap.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("message", onNativeKeyboard);
      wrap.style.height = "";
    };
  }, []);

  return (
    <div className="ob-wrap" ref={wrapRef}>
      <DragRegion />
      {children}
    </div>
  );
}

/* ── shell: modal over the app shell (desktop) ─────────────────────────── */
function OnboardingDialog({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <>
      {/* The overlay covers the app's own drag regions, so restore one here. */}
      <DragRegion />
      <Dialog open>
        <DialogContent
          className="ob-dialog"
          // There is no app behind this yet — the flow can't be dismissed.
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          // First tabbable is "Skip setup" in the card head, and opening the
          // flow focused on its escape hatch (Enter would take it) reads as an
          // invitation to leave. Park focus on the dialog itself instead.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          {/* Each step carries its own heading; this names the dialog itself. */}
          <DialogTitle className="sr-only">
            {t("onboarding.dialogTitle", "Set up Tasfer")}
          </DialogTitle>
          {children}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Electron: fixed drag region at top so the frameless window can be moved. */
function DragRegion() {
  return (
    <div
      className="ob-drag-region"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    />
  );
}

/* ── root ──────────────────────────────────────────────────────────────── */
export function OnboardingScreen() {
  const { user } = useAuth();
  const { isMobile } = useMobileLayout();
  const [step, setStep] = useState<Step>(STEPS[0]);
  const [name, setName] = useState(user?.name ?? "");
  const [avatarId, setAvatarId] = useState<string | null>(user?.avatar ?? null);
  /** Linking branches off the identity step rather than sitting inside STEPS. */
  const [linking, setLinking] = useState(false);
  /** A code being handed between the two flows after a wrong-kind mix-up. */
  const [handoff, setHandoff] = useState("");

  const go = (s: Step) => setStep(s);
  const Shell = isMobile ? OnboardingPage : OnboardingDialog;

  useSpacesArrive();

  return (
    <StepContext.Provider value={step}>
      <Shell>
        {linking ? (
          <LinkExistingStep
            initialCode={handoff}
            onBack={() => {
              setHandoff("");
              setLinking(false);
            }}
            onSpaceInvite={(code) => {
              setHandoff(code);
              setLinking(false);
              go("space");
            }}
            onSetUpSpace={() => {
              setHandoff("");
              setLinking(false);
              go("space");
            }}
          />
        ) : (
          <>
            {step === "identity" && (
              <IdentityStep
                onNext={() => go("profile")}
                onLink={() => {
                  setHandoff("");
                  setLinking(true);
                }}
              />
            )}
            {step === "profile" && (
              <ProfileStep
                name={name}
                setName={setName}
                avatarId={avatarId}
                setAvatarId={setAvatarId}
                onNext={() => go("space")}
                onBack={() => go("identity")}
              />
            )}
            {step === "space" && (
              <SpaceStep
                onBack={() => {
                  setHandoff("");
                  go("profile");
                }}
                initialCode={handoff}
                onDeviceLink={(code) => {
                  setHandoff(code);
                  setLinking(true);
                }}
              />
            )}
          </>
        )}
      </Shell>
    </StepContext.Provider>
  );
}
