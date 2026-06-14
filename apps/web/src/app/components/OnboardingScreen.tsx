/* OnboardingScreen.tsx — Cypher first-run flow.
 *   1. folder    — pick the on-disk folder pages are mirrored to (one-way export)
 *   2. identity  — the keypair Cypher already generated; on-device by default
 *   3. profile   — optional name + avatar (collapsed), only matters for sharing
 *   4. space     — create your own (optional name) OR join a peer's
 *                  (paste code / import invite file / scan QR)
 *
 * UI ported from the Claude Design handoff bundle (see OnboardingScreen.css).
 * Every step is wired to the real platform APIs. The folder step persists a real
 * directory handle via src/lib/syncFolder.ts — the in-app CRDT op-log stays the
 * source of truth, and that folder is the destination of a one-way markdown
 * mirror (the export/sync itself is wired up separately).
 */

import type { DeviceType, SpaceInvite } from "@/platform/types";
import { useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Fingerprint,
  Folder,
  FolderOpen,
  ImagePlus,
  Loader2,
  Lock,
  Moon,
  Plus,
  QrCode,
  Share2,
  ShieldCheck,
  Sun,
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
  useAcceptInvite,
  useCreateSpace,
} from "../api/spaces.api";
import {
  getSyncFolderName,
  isSyncFolderSupported,
  pickSyncFolder,
} from "@/lib/syncFolder";
import { useAuth } from "../contexts/AuthContext";
import { useKeyboardOpen } from "../hooks/useKeyboardOpen";
import { useTheme } from "../hooks/useTheme";
import { AvatarCropDialog } from "./AvatarCropDialog";
import { QRScannerView } from "./QRScannerView";
import "./OnboardingScreen.css";

const STEPS = ["folder", "identity", "profile", "space"] as const;
type Step = (typeof STEPS)[number];

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
    const raw = bytes.subarray(64, 80);
    const end = raw.indexOf(0);
    const spaceId = new TextDecoder().decode(
      raw.subarray(0, end >= 0 ? end : 16),
    );
    return { topic, secret, spaceId };
  } catch {
    return null;
  }
}

function detectDeviceType(): DeviceType {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent;

  // Check for tablets first (before phone detection)
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && "ontouchend" in document)) {
    return "tablet";
  }
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) {
    return "tablet";
  }

  // Phones
  if (/iPhone|iPod/i.test(ua)) return "phone";
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return "phone";

  // Desktop vs Laptop — can't truly distinguish, default to laptop for portables
  return "laptop";
}

/* ── progress dots ─────────────────────────────────────────────────────── */
function ProgressDots({ step }: { step: Step }) {
  const idx = STEPS.indexOf(step);
  return (
    <div className="ob-dots" role="presentation">
      {STEPS.map((s, i) => (
        <div
          key={s}
          className={`ob-dot${
            s === step ? " ob-dot-active" : i < idx ? " ob-dot-done" : ""
          }`}
        />
      ))}
    </div>
  );
}

/* ── 1. sync folder ────────────────────────────────────────────────────── */
function FolderStep({
  folder,
  setFolder,
  onNext,
}: {
  folder: string;
  setFolder: (v: string) => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const supported = isSyncFolderSupported();

  // Open the OS directory picker and persist the chosen handle (see
  // src/lib/syncFolder.ts). We only keep the folder *name* in local state for
  // display — the writable handle is saved to IndexedDB for the one-way sync.
  async function choose() {
    setPicking(true);
    try {
      const res = await pickSyncFolder();
      if (res) setFolder(res.name);
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="ob-card">
      <div className="ob-icon-wrap">
        <FolderOpen size={22} strokeWidth={1.5} />
      </div>
      <h2 className="ob-title">
        {t("onboarding.folderTitle", "Where should your pages be saved?")}
      </h2>
      <p className="ob-sub">
        {t(
          "onboarding.folderDesc",
          "Pick a folder and Cypher mirrors every page into it as plain markdown — a one-way copy you fully own. Open it in any editor, back it up, put it in git. The app keeps the source of truth; the folder is always yours.",
        )}
      </p>

      <label className="ob-label">
        {t("onboarding.folderLabel", "Sync folder")}
      </label>
      {folder ? (
        <div className="ob-folder-card">
          <div className="ob-folder-ico">
            <Folder size={18} strokeWidth={1.5} />
          </div>
          <div className="ob-folder-text">
            <div className="ob-folder-name">{folder}</div>
            <div className="ob-folder-path">
              {t("onboarding.folderMirror", "one-way markdown mirror")}
            </div>
          </div>
          <button className="ob-link-btn" onClick={choose} disabled={picking}>
            {t("common.change", "Change")}
          </button>
        </div>
      ) : (
        <button className="ob-pick-btn" onClick={choose} disabled={picking}>
          {picking ? (
            <Loader2 size={18} strokeWidth={2} className="ob-spin-icon" />
          ) : (
            <Folder size={18} strokeWidth={1.5} />
          )}
          {t("onboarding.chooseFolder", "Choose folder…")}
        </button>
      )}

      <div className="ob-note">
        <Check size={14} strokeWidth={1.5} />
        <span>
          {supported
            ? t(
                "onboarding.folderNote",
                "Mirroring is one-way — Cypher writes here, it never reads your edits back from the folder.",
              )
            : t(
                "onboarding.folderUnsupported",
                "Folder export isn't available in this browser — you can set it later on desktop.",
              )}
        </span>
      </div>

      <div className="ob-actions">
        <button className="ob-btn ob-btn-primary" onClick={onNext}>
          {folder ? t("common.continue", "Continue") : t("common.skip", "Skip")}
        </button>
      </div>
    </div>
  );
}

/* ── 2. identity ───────────────────────────────────────────────────────── */
function IdentityStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);

  const publicKey = user?.id ?? "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(publicKey);
    } catch {
      // clipboard may be unavailable; the visual confirmation still fires
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="ob-card">
      <div className="ob-icon-wrap">
        <Fingerprint size={22} strokeWidth={1.5} />
      </div>
      <h2 className="ob-title">
        {t("onboarding.identityTitle", "An identity was created for you.")}
      </h2>
      <p className="ob-sub">
        {t(
          "onboarding.identityIntro",
          "The moment you opened Cypher, it generated a keypair on this device. Your public key is how peers recognize you. The private key never leaves this machine — there's no account and no server that ever sees it.",
        )}
      </p>

      <div className="ob-key-block">
        <span className="ob-key-label">
          {t("onboarding.yourPublicKey", "your public key")}
        </span>
        <code>{publicKey}</code>
      </div>
      <button
        className="ob-avatar-btn"
        style={{ marginTop: 10 }}
        onClick={copy}
      >
        <Copy size={14} strokeWidth={1.5} />
        {copied ? t("share.copied", "Copied") : t("onboarding.copyKey", "Copy key")}
      </button>

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

      <div className="ob-actions">
        {onBack && (
          <button className="ob-btn ob-btn-ghost" onClick={onBack}>
            {t("common.back", "Back")}
          </button>
        )}
        <button className="ob-btn ob-btn-primary" onClick={onNext}>
          {t("common.continue", "Continue")}
        </button>
      </div>
    </div>
  );
}

/* ── 3. profile (optional, collapsed) ──────────────────────────────────── */
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
          deviceType: detectDeviceType(),
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
      <div className="ob-icon-wrap">
        <Share2 size={22} strokeWidth={1.5} />
      </div>
      <h2 className="ob-title">
        {t("onboarding.profileTitle", "A face for sharing — if you want one.")}
      </h2>
      <p className="ob-sub">
        {t(
          "onboarding.profileIntro",
          "Cypher works fully anonymous. The only time a name or avatar matters is when you invite someone to a space — it's how they'll tell your edits apart. You can add this now or never.",
        )}
      </p>

      <div className="ob-collapse">
        <button
          className="ob-collapse-head"
          onClick={() => setOpen((o) => !o)}
        >
          <User size={18} strokeWidth={1.5} />
          <div>
            <div className="ob-collapse-title">
              {t("onboarding.addNameAvatar", "Add a name & avatar")}
            </div>
            <div className="ob-collapse-sub">
              {name.trim()
                ? name.trim()
                : t("onboarding.optionalForShared", "Optional · for shared spaces")}
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
              <div className={`ob-avatar${avatarUrl || initial ? "" : " empty"}`}>
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
          {hasContent
            ? t("common.continue", "Continue")
            : t("common.skip", "Skip")}
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

/* ── 4a. space — pick ──────────────────────────────────────────────────── */
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

      <div className="ob-actions">
        <button className="ob-btn ob-btn-ghost" onClick={onBack}>
          {t("common.back", "Back")}
        </button>
      </div>
    </div>
  );
}

/* ── 4b. space — create ────────────────────────────────────────────────── */
function SpaceCreate({ setView }: { setView: (v: SpaceView) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [org, setOrg] = useState("");

  const { mutate: createSpace, isPending: isCreating } = useCreateSpace({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },
  });

  function handleCreate() {
    // Space name is optional in the flow; fall back to a sensible default.
    createSpace({ name: org.trim() || t("common.personal", "Personal") });
  }

  return (
    <div className="ob-card">
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

/* ── 4c. space — join ──────────────────────────────────────────────────── */
type JoinMethod = "code" | "file" | "scan";
type JoinStatus = "input" | "connecting" | "done" | "error";

function SpaceJoin({ setView }: { setView: (v: SpaceView) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<JoinMethod>("code");
  const [code, setCode] = useState("");
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState<JoinStatus>("input");
  const [camera, setCamera] = useState(false);
  const [spaceName, setSpaceName] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { mutate: acceptInvite } = useAcceptInvite();

  const canJoin =
    (method === "code" && code.trim().length > 0) ||
    (method === "file" && Boolean(fileName));

  function runJoin(raw: string) {
    const invite = decodeInvite(raw);
    if (!invite) {
      setStatus("error");
      setErrorMsg(t("space.invalidInviteCode", "Invalid invite code"));
      return;
    }
    setStatus("connecting");
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

  function handleScan(data: string) {
    setCamera(false);
    runJoin(data);
  }

  function handleCancel() {
    cancelPairing();
    setStatus("input");
    setSpaceName("");
    setErrorMsg("");
  }

  useEffect(() => {
    return () => {
      cancelPairing();
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
            {t("space.connectingToSpace", "Connecting…")}
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
            {spaceName
              ? t("space.joinedSpace", 'Joined "{{name}}" successfully!', {
                  name: spaceName,
                })
              : t("space.peerConnected", "Connected!")}
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
          <button
            className="ob-btn ob-btn-outline"
            onClick={() => setStatus("input")}
          >
            {t("common.tryAgain", "Try again")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ob-card">
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
          <Copy size={14} strokeWidth={1.5} />{" "}
          {t("onboarding.pasteCode", "Paste code")}
        </button>
        <button
          role="tab"
          aria-current={method === "file"}
          onClick={() => setMethod("file")}
        >
          <Upload size={14} strokeWidth={1.5} />{" "}
          {t("onboarding.importFile", "Import file")}
        </button>
        <button
          role="tab"
          aria-current={method === "scan"}
          onClick={() => setMethod("scan")}
        >
          <QrCode size={14} strokeWidth={1.5} />{" "}
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
            className={`ob-import${fileName ? " has-file" : ""}`}
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
              {fileName || t("onboarding.chooseInviteFile", "Choose an invite file")}
            </span>
            <span className="ob-import-sub">
              {fileName
                ? t("onboarding.tapToRemove", "Tap to remove")
                : t("onboarding.cypherInviteHint", "A .cypherinvite file from your peer")}
            </span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".cypherinvite,text/plain,application/json"
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

/* ── camera drawer (bottom sheet hosting the real QR scanner) ──────────── */
function CameraDrawer({
  onScan,
  onClose,
}: {
  onScan: (data: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="ob-scrim" onClick={onClose}>
      <div className="ob-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ob-drawer-grip" />
        <div className="ob-drawer-head">
          <h3>{t("onboarding.scanInviteQR", "Scan invite QR")}</h3>
          <button
            className="ob-icon-btn"
            onClick={onClose}
            aria-label={t("common.close", "Close")}
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>
        <p className="ob-drawer-sub">
          {t(
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
      </div>
    </div>
  );
}

/* ── space router ──────────────────────────────────────────────────────── */
type SpaceView = "pick" | "create" | "join";

function SpaceStep({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<SpaceView>("pick");
  if (view === "create") return <SpaceCreate setView={setView} />;
  if (view === "join") return <SpaceJoin setView={setView} />;
  return <SpacePick setView={setView} onBack={onBack} />;
}

/* ── theme toggle ──────────────────────────────────────────────────────── */
function ThemeToggle() {
  const { t } = useTranslation();
  const { effectiveTheme, setTheme } = useTheme();
  const isDark = effectiveTheme === "dark";
  return (
    <button
      className="ob-theme-toggle"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={t("settings.theme.modeKw", "Toggle theme")}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {isDark ? (
        <Sun size={17} strokeWidth={1.5} />
      ) : (
        <Moon size={17} strokeWidth={1.5} />
      )}
    </button>
  );
}

/* ── root ──────────────────────────────────────────────────────────────── */
export function OnboardingScreen() {
  const { user } = useAuth();
  const { keyboardHeight } = useKeyboardOpen();

  const [step, setStep] = useState<Step>("folder");
  // Persisted folder name (the writable handle lives in IndexedDB via syncFolder).
  const [folder, setFolder] = useState(() => getSyncFolderName() ?? "");
  const [name, setName] = useState(user?.name ?? "");
  const [avatarId, setAvatarId] = useState<string | null>(user?.avatar ?? null);

  const go = (s: Step) => setStep(s);

  return (
    <div
      className="ob-wrap"
      style={{ paddingBottom: `calc(32px + ${keyboardHeight}px)` }}
    >
      {/* Electron: fixed drag region at top so the window can be moved */}
      <div
        className="fixed inset-x-0 top-0 h-12 z-50"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      <ThemeToggle />

      <ProgressDots step={step} />

      {step === "folder" && (
        <FolderStep
          folder={folder}
          setFolder={setFolder}
          onNext={() => go("identity")}
        />
      )}
      {step === "identity" && (
        <IdentityStep
          onNext={() => go("profile")}
          onBack={() => go("folder")}
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
      {step === "space" && <SpaceStep onBack={() => go("profile")} />}
    </div>
  );
}
