import { updateProfile } from "@/app/api/auth.api";
import { useAssetUrl, uploadImage } from "@/app/api/images.api";
import { AvatarCropDialog } from "@/app/components/AvatarCropDialog";
import { AvatarPreviewDialog } from "@/app/components/AvatarPreviewDialog";
import { useAuth } from "@/app/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Camera, Trash } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import styles from "./Profile.module.css";

export function Profile() {
  const { t } = useTranslation();
  const { user, updateUser } = useAuth();

  const [name, setName] = React.useState(user?.name ?? "");
  const [avatarId, setAvatarId] = React.useState<string | null>(
    user?.avatar ?? null,
  );
  const [uploading, setUploading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [pendingFile, setPendingFile] = React.useState<File | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const avatarUrl = useAssetUrl(avatarId);

  const hasChanges =
    name !== (user?.name ?? "") || avatarId !== (user?.avatar ?? null);

  function handleAvatarClick() {
    if (avatarId) {
      setPreviewOpen(true);
    } else {
      fileInputRef.current?.click();
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

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

  function handleCropCancel() {
    setPendingFile(null);
  }

  function handleRemoveAvatar() {
    setAvatarId(null);
  }

  async function handleSave() {
    if (!hasChanges) return;

    try {
      setSaving(true);
      const updated = await updateProfile({
        name: name.trim(),
        avatar: avatarId,
      });
      updateUser(updated);
    } catch (err) {
      console.error("Failed to update profile:", err);
    } finally {
      setSaving(false);
    }
  }

  const initials = (user?.name ?? "?").charAt(0).toUpperCase();

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <div className={styles.row}>
          <div className={styles.column}>
            <p className={cn("text-sm", styles.title)}>{t("common.avatar", "Avatar")}</p>
            <p className="text-sm opacity-75">{t("profile.clickToUpload", "Click to upload a profile picture")}</p>
          </div>

          <div className={styles.avatarSection}>
            <div className="flex justify-center items-center gap-3">
              {avatarId && (
                <Button
                  variant="destructive"
                  size="icon-sm"
                  onClick={handleRemoveAvatar}
                  className="w-fit px-1 pe-2 gap-1"
                >
                  <Trash size={12} />
                  {t("common.remove", "Remove")}
                </Button>
              )}
              <div
                className={styles.avatarWrapper}
                onClick={handleAvatarClick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleAvatarClick()}
              >
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt="Avatar"
                    className={styles.avatar}
                  />
                ) : (
                  <div className={styles.avatarPlaceholder}>{initials}</div>
                )}
                <div
                  className={styles.avatarOverlay}
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                >
                  <Camera size={20} />
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={handleFileChange}
                hidden
              />
            </div>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <div className={styles.column}>
            <p className={cn("text-sm", styles.title)}>{t("common.name", "Name")}</p>
            <p className="text-sm opacity-75">{t("profile.displayName", "Your display name")}</p>
          </div>

          <Input
            className={styles.nameInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("profile.enterName", "Enter your name")}
          />
        </div>
      </div>

      <div className={styles.actions}>
        <Button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          loading={saving || uploading}
        >
          {t("common.save", "Save")}
        </Button>
      </div>

      <AvatarCropDialog
        file={pendingFile}
        onCropped={handleCropped}
        onCancel={handleCropCancel}
      />

      <AvatarPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        imageUrl={avatarUrl}
        name={user?.name}
      />
    </div>
  );
}
